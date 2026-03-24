import { randomUUID } from "crypto";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { withDbClient } from "../db.js";
import { postToFeed } from "../feed.js";
import { taskLogs } from "../task-logs.js";
import type { ToolDefinition, McpToolResult } from "./git-tools.js";

const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "claude-sonnet-4-6";

function modelCostPerMillion(model?: string): { input: number; output: number } {
  if (!model) return { input: 3, output: 15 };
  const m = model.toLowerCase();
  if (m.includes("haiku")) return { input: 0.25, output: 1.25 };
  if (m.includes("opus")) return { input: 15, output: 75 };
  return { input: 3, output: 15 };
}

const codeTaskEnabled = process.env.CODE_TASK_ENABLED === "true";

export const codeExecutionToolDefinitions: ToolDefinition[] = [
  ...(codeTaskEnabled ? [{
    name: "code_task",
    description: "Run a coding task via Claude or Cline agent",
    policy_class: "privileged" as const,
    inputSchema: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "Task instruction" },
        working_dir: { type: "string", description: "Working directory" },
        driver: {
          type: "string",
          enum: ["claude", "cline"],
          default: "claude",
          description: "Agent driver to use",
        },
        task_id: { type: "string", description: "Optional task ID (uuid generated if not provided)" },
        max_turns: { type: "number", default: 30 },
        budget_usd: { type: "number", default: 5.0 },
        timeout_seconds: { type: "number", default: 900 },
        task_rules: { type: "string", description: "Extra rules to append to system prompt" },
        base_rules_path: { type: "string", default: "/home/david/.rules/base.md" },
        project_rules_path: { type: "string", default: "/.rules/project.md" },
        session_id: { type: "string", description: "ops-db session ID to post execution_update messages to" },
        ops_db_url: { type: "string", description: "PostgreSQL connection URL (falls back to OPS_DB_URL env)" },
        model: {
          type: "string",
          description: "Model override (e.g. 'haiku', 'sonnet', 'opus', or full model ID). Defaults to account default.",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "max"],
          description: "Effort level (controls reasoning depth). Default: medium.",
        },
        agents: {
          type: "string",
          description: "JSON object defining custom sub-agents available to this task.",
        },
        allowed_tools: {
          type: "array",
          items: { type: "string" },
          description: "Whitelist of tools the CLI may use.",
        },
        resume_claude_session_id: {
          type: "string",
          description: "Resume a previous claude CLI session by session ID for context continuity across passes.",
        },
        add_dirs: {
          type: "array",
          items: { type: "string" },
          description: "Additional directories to allow tool access to (passed as --add-dir).",
        },
      },
      required: ["instruction", "working_dir"],
    },
  }] : []),
  {
    name: "get_task_log",
    description: "Get buffered log lines for a task",
    policy_class: "read_only",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "run_tests",
    description: "Run tests in a working directory",
    policy_class: "mutating",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        test_cmd: { type: "string", description: "Test command (falls back to .project.json or TEST_CMD)" },
      },
      required: ["working_dir"],
    },
  },
  {
    name: "run_build",
    description: "Run build in a working directory",
    policy_class: "mutating",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
        build_cmd: { type: "string", description: "Build command (falls back to .project.json or BUILD_CMD)" },
      },
      required: ["working_dir"],
    },
  },
];

export async function handleCodeExecutionTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  switch (name) {
    case "code_task": {
      if (process.env.CODE_TASK_ENABLED !== "true") {
        return { content: [{ type: "text", text: "code_task is disabled on this container (CODE_TASK_ENABLED not set to true)" }], isError: true };
      }
      const {
        instruction,
        working_dir,
        driver = "claude",
        task_id,
        max_turns = 30,
        budget_usd = 5.0,
        timeout_seconds = 900,
        task_rules,
        base_rules_path = "/home/david/.rules/base.md",
        project_rules_path = "/.rules/project.md",
        session_id,
        ops_db_url,
        model,
        effort,
        agents,
        allowed_tools,
        resume_claude_session_id,
        add_dirs,
      } = args as {
        instruction: string;
        working_dir: string;
        driver?: string;
        task_id?: string;
        max_turns?: number;
        budget_usd?: number;
        timeout_seconds?: number;
        task_rules?: string;
        base_rules_path?: string;
        project_rules_path?: string;
        session_id?: string;
        ops_db_url?: string;
        model?: string;
        effort?: string;
        agents?: string;
        allowed_tools?: string[];
        resume_claude_session_id?: string;
        add_dirs?: string[];
      };

      const dbUrl = ops_db_url || process.env.OPS_DB_URL;

      const taskId = task_id || randomUUID();
      taskLogs.set(taskId, []);
      const log = (line: string) => taskLogs.get(taskId)!.push(line);
      const debugLogPath = `/tmp/task-${taskId}-debug.log`;

      postToFeed(session_id, dbUrl, `🤖 Model: ${model || "default (account)"} | driver: ${driver} | effort: ${effort || "medium"} | task_id: ${taskId}`);

      // Compose rules
      let rules = "";
      try { rules += fs.readFileSync(base_rules_path, "utf8") + "\n"; } catch {}
      try { rules += fs.readFileSync(path.join(working_dir, project_rules_path), "utf8") + "\n"; } catch {}
      if (task_rules) rules += task_rules + "\n";

      if (driver === "claude") {
        const rulesFile = `/tmp/container-mcp-rules-${taskId}.md`;
        fs.writeFileSync(rulesFile, rules);

        (async () => {
          try {
            const memUsage = process.memoryUsage();
            console.log(`[code_task] Starting task ${taskId}. Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);

            const claudeArgs: string[] = [
              "-p", instruction,
              "--output-format", "stream-json",
              "--verbose",
              "--include-partial-messages",
              "--append-system-prompt-file", rulesFile,
              "--permission-mode", "acceptEdits",
              "--max-turns", String(max_turns),
              "--max-budget-usd", String(budget_usd),
              "--session-id", taskId,
              "--dangerously-skip-permissions",
              "--debug-file", debugLogPath,
            ];

            claudeArgs.push("--model", model || DEFAULT_MODEL);
            if (effort) claudeArgs.push("--effort", effort);
            if (agents) claudeArgs.push("--agents", typeof agents === "string" ? agents : JSON.stringify(agents));
            if (allowed_tools && Array.isArray(allowed_tools) && allowed_tools.length > 0) {
              claudeArgs.push("--allowed-tools", allowed_tools.join(","));
            }
            if (resume_claude_session_id) claudeArgs.push("--resume", resume_claude_session_id);
            if (add_dirs && Array.isArray(add_dirs)) {
              for (const dir of add_dirs) claudeArgs.push("--add-dir", dir);
            }

            const proc = spawn("claude", claudeArgs, {
              cwd: working_dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] as const,
            });

            if (session_id && dbUrl) {
              const resolvedModel = model || "default";
              void withDbClient(dbUrl, async (client) => {
                await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model TEXT`).catch(() => {});
                await client.query(`UPDATE sessions SET model = $1 WHERE session_id = $2`, [resolvedModel, session_id]);
              }).catch(() => {});
            }

            let output = "";
            const timer = setTimeout(() => { proc.kill("SIGTERM"); }, timeout_seconds * 1000);
            const toolUseMap = new Map<string, string>();

            proc.stdout.on("data", (chunk: Buffer) => {
              const lines = chunk.toString().split("\n");
              for (const line of lines) {
                if (!line.trim()) continue;
                log(line);
                try {
                  const parsed = JSON.parse(line) as Record<string, unknown>;
                  if (parsed.type === "result") {
                    const claudeSessionId = parsed.session_id as string | undefined;
                    if (claudeSessionId && session_id && dbUrl) {
                      void withDbClient(dbUrl, async (client) => {
                        await client.query(
                          `UPDATE sessions SET claude_session_id = $1, updated_at = now() WHERE session_id = $2`,
                          [claudeSessionId, session_id]
                        );
                      }).catch(() => {});
                    }
                    output = (parsed.result || parsed.output || JSON.stringify(parsed)) as string;
                    postToFeed(session_id, dbUrl, `✅ Task complete\n\n${output.slice(0, 4000)}`);
                    const usage = parsed.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
                    if (usage && (usage.input_tokens || usage.output_tokens) && session_id && dbUrl) {
                      const inputTokens = usage.input_tokens || 0;
                      const outputTokens = usage.output_tokens || 0;
                      const totalTokens = inputTokens + outputTokens;
                      const { input: inputCostPerM, output: outputCostPerM } = modelCostPerMillion(model);
                      const costUsd = (inputTokens / 1_000_000 * inputCostPerM) + (outputTokens / 1_000_000 * outputCostPerM);
                      void withDbClient(dbUrl, async (client) => {
                        await client.query(
                          `UPDATE sessions SET token_usage = COALESCE(token_usage, 0) + $1, cost_usd = COALESCE(cost_usd, 0) + $2 WHERE session_id = $3`,
                          [totalTokens, costUsd, session_id]
                        );
                      }).catch((err: unknown) => console.error('[token-usage] Failed to update token usage:', err));
                    }
                  } else if (parsed.type === "assistant") {
                    const content = (parsed.message as { content?: Array<{ type: string; id?: string; name?: string; input?: unknown; thinking?: string; text?: string }> })?.content || [];
                    for (const block of content) {
                      if (block.type === "tool_use") {
                        if (block.id) toolUseMap.set(block.id, block.name ?? "");
                        const toolInput = JSON.stringify(block.input || {}).slice(0, 500);
                        postToFeed(session_id, dbUrl, `🔧 \`${block.name}\` ${toolInput}`);
                      } else if (block.type === "thinking" && block.thinking?.trim()) {
                        postToFeed(session_id, dbUrl, `🧠 ${block.thinking.trim().slice(0, 600)}`);
                      } else if (block.type === "text" && block.text?.trim() && !(parsed.message as { usage?: unknown })?.usage) {
                        const text = block.text.trim().slice(0, 1000);
                        if (text.length > 20) postToFeed(session_id, dbUrl, `💭 ${text}`);
                      }
                    }
                  } else if (parsed.type === "user") {
                    const content = (parsed.message as { content?: Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> })?.content || [];
                    for (const block of content) {
                      if (block.type === "tool_result") {
                        const toolName = toolUseMap.get(block.tool_use_id ?? "") || block.tool_use_id || "unknown";
                        let resultText = "";
                        if (typeof block.content === "string") resultText = block.content;
                        else if (Array.isArray(block.content)) resultText = (block.content as Array<{ text?: string }>).map((c) => c.text || "").join("\n");
                        if (resultText) postToFeed(session_id, dbUrl, `📄 ${toolName} → ${resultText.slice(0, 800)}`);
                      }
                    }
                  }
                } catch {}
              }
            });
            proc.stderr.on("data", (chunk: Buffer) => {
              const text = chunk.toString();
              log("[stderr] " + text);
              postToFeed(session_id, dbUrl, text.slice(0, 500), "system", "console");
            });
            proc.on("close", (code: number | null) => {
              clearTimeout(timer);
              try { fs.unlinkSync(rulesFile); } catch {}
              postToFeed(session_id, dbUrl, `✅ Process ${taskId} exited with code ${code}. Debug log: ${debugLogPath}`);
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[code_task] Error in async spawn: ${message}`);
            postToFeed(session_id, dbUrl, `❌ Task ${taskId} failed to start: ${message}`);
          }
        })().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[code_task] Unhandled rejection: ${message}`);
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              task_id: taskId,
              status: "spawned",
              debug_log: debugLogPath,
              message: `Process spawned. Poll get_task_log('${taskId}') or read ${debugLogPath} for output.`
            })
          }]
        };
      } else {
        // cline driver
        const clinerules = path.join(working_dir, ".clinerules");
        fs.writeFileSync(clinerules, rules);

        (async () => {
          try {
            const memUsage = process.memoryUsage();
            console.log(`[code_task] Starting task ${taskId}. Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);

            const proc = spawn(
              "/home/david/.npm-local/bin/cline",
              ["-y", "--json", "--timeout", String(timeout_seconds), instruction],
              {
                cwd: working_dir,
                env: {
                  ...process.env,
                  CLINE_COMMAND_PERMISSIONS: JSON.stringify({
                    allow: ["npm *", "git *", "node *", "npx *", "yarn *", "pnpm *"],
                    deny: ["rm -rf /", "sudo *"],
                  }),
                },
              }
            );

            const outputLines: string[] = [];
            const timer = setTimeout(() => { proc.kill("SIGTERM"); }, timeout_seconds * 1000);

            proc.stdout.on("data", (chunk: Buffer) => {
              const lines = chunk.toString().split("\n");
              for (const line of lines) {
                if (!line.trim()) continue;
                log(line);
                try {
                  const parsed = JSON.parse(line) as { type?: string; partial?: boolean; text?: string; say?: string };
                  if (parsed.type === "say" && !parsed.partial) {
                    outputLines.push(parsed.text || "");
                    if (parsed.say === "text") {
                      postToFeed(session_id, dbUrl, `💭 ${(parsed.text || "").slice(0, 500)}`);
                    } else if (parsed.say === "tool") {
                      postToFeed(session_id, dbUrl, `🔧 ${(parsed.text || "").slice(0, 300)}`);
                    } else if (parsed.say === "completion_result") {
                      postToFeed(session_id, dbUrl, `✅ Done: ${(parsed.text || "").slice(0, 1000)}`);
                    }
                  }
                } catch {}
              }
            });
            proc.stderr.on("data", (chunk: Buffer) => log("[stderr] " + chunk.toString()));
            proc.on("close", (code: number | null) => {
              clearTimeout(timer);
              try { fs.unlinkSync(clinerules); } catch {}
              postToFeed(session_id, dbUrl, `✅ Process ${taskId} exited with code ${code}`);
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[code_task] Error in async spawn: ${message}`);
            postToFeed(session_id, dbUrl, `❌ Task ${taskId} failed to start: ${message}`);
          }
        })().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[code_task] Unhandled rejection: ${message}`);
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              task_id: taskId,
              status: "spawned",
              message: `Process spawned. Poll get_task_log('${taskId}') for output.`
            })
          }]
        };
      }
    }

    case "get_task_log": {
      const { task_id } = args as { task_id: string };
      const logs = taskLogs.get(task_id) || [];
      return { content: [{ type: "text", text: JSON.stringify({ task_id, lines: logs }) }] };
    }

    case "run_tests": {
      const { working_dir, test_cmd } = args as { working_dir: string; test_cmd?: string };
      let cmd = test_cmd;
      if (!cmd) {
        try {
          const proj = JSON.parse(fs.readFileSync(path.join(working_dir, ".project.json"), "utf8")) as { testCmd?: string };
          cmd = proj.testCmd;
        } catch {}
      }
      if (!cmd) cmd = process.env.TEST_CMD || "npm test";
      const r = spawnSync(cmd, { shell: true, cwd: working_dir, encoding: "utf8" });
      const output = (r.stdout || "") + (r.stderr || "");
      return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
    }

    case "run_build": {
      const { working_dir, build_cmd } = args as { working_dir: string; build_cmd?: string };
      let cmd = build_cmd;
      if (!cmd) {
        try {
          const proj = JSON.parse(fs.readFileSync(path.join(working_dir, ".project.json"), "utf8")) as { buildCmd?: string };
          cmd = proj.buildCmd;
        } catch {}
      }
      if (!cmd) cmd = process.env.BUILD_CMD || "npm run build";
      const r = spawnSync(cmd, { shell: true, cwd: working_dir, encoding: "utf8" });
      const output = (r.stdout || "") + (r.stderr || "");
      return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
    }

    default:
      return { content: [{ type: "text", text: `Unknown code execution tool: ${name}` }], isError: true };
  }
}
