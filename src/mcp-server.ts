import { randomUUID } from "crypto";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "pg";
import { withDbClient, notifySessionMessage } from "./db.js";
import { postToFeed, _feedClients } from "./feed.js";
import { taskLogs } from "./task-logs.js";
import { populateCacheForProject, writeCacheEntry } from "./jira-confluence.js";
import { deployProject } from "./tools/deploy-project.js";
import { transitionSession, nextAllowedActions, SESSION_TRANSITIONS, type SessionStatus } from "./state-machine.js";
import { DEFAULT_MODEL } from "./model-registry.js";
import { spawnCodeTask } from "./code-task.js";

function resolveClaudeBin(): string {
  const candidates = [
    process.env.CLAUDE_BIN,
    "/home/openclaw/.npm-global/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    "claude",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (c === "claude") return c;
      require("fs").accessSync(c);
      return c;
    } catch {}
  }
  return "claude";
}

// DEFAULT_MODEL imported from model-registry

function modelCostPerMillion(model?: string): { input: number; output: number } {
  if (!model) return { input: 3, output: 15 };
  const m = model.toLowerCase();
  if (m.includes("haiku")) return { input: 0.25, output: 1.25 };
  if (m.includes("opus")) return { input: 15, output: 75 };
  return { input: 3, output: 15 };
}

export function createMcpServer() {
  const server = new Server(
    { name: "container-mcp", version: "2.2.0" },
    { capabilities: { tools: {} } }
  );

  const codeTaskEnabled = process.env.CODE_TASK_ENABLED === "true";

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(codeTaskEnabled ? [{
      
        name: "code_task",
        description: "Run a coding task via Claude or Cline agent",
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
        inputSchema: {
          type: "object",
          properties: {
            working_dir: { type: "string" },
            build_cmd: { type: "string", description: "Build command (falls back to .project.json or BUILD_CMD)" },
          },
          required: ["working_dir"],
        },
      },
      {
        name: "get_diff",
        description: "Get git diff for a working directory",
        inputSchema: {
          type: "object",
          properties: {
            working_dir: { type: "string" },
            from_ref: { type: "string", default: "HEAD" },
            to_ref: { type: "string", description: "Target ref (default: working tree)" },
          },
          required: ["working_dir"],
        },
      },
      {
        name: "get_repo_state",
        description: "Get current git repo state",
        inputSchema: {
          type: "object",
          properties: {
            working_dir: { type: "string" },
          },
          required: ["working_dir"],
        },
      },
      {
        name: "cache_read",
        description: "Read a cached project context summary from ops-db project_context_cache",
        inputSchema: {
          type: "object",
          properties: {
            cache_key: { type: "string", description: "Cache key such as confluence:4128178218 or jira:ZI-18807" },
          },
          required: ["cache_key"],
        },
      },
      {
        name: "cache_write",
        description: "Upsert a cached project context summary into ops-db project_context_cache",
        inputSchema: {
          type: "object",
          properties: {
            cache_key: { type: "string" },
            source_type: { type: "string" },
            content_hash: { type: "string" },
            source_updated: { type: "string", description: "ISO timestamp or empty string/null" },
            summary: { type: "string" },
          },
          required: ["cache_key", "source_type", "content_hash", "summary"],
        },
      },
      {
        name: "listen_for_approval",
        description: "Wait on Postgres LISTEN/NOTIFY for a session approval_response",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            timeout_seconds: { type: "number", default: 1800 },
          },
          required: ["session_id"],
        },
      },
      {
        name: "git_status",
        description: "Get git status for a repo (branch, staged, unstaged, untracked files)",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Short repo name, resolved to /home/david/<repo>" },
          },
          required: ["repo"],
        },
      },
      {
        name: "git_checkout",
        description: "Switch or create a git branch",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Short repo name" },
            branch: { type: "string", description: "Branch name to checkout" },
            create: { type: "boolean", default: false, description: "Create branch if true (-b flag)" },
          },
          required: ["repo", "branch"],
        },
      },
      {
        name: "git_add",
        description: "Stage files for commit",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Short repo name" },
            files: { type: "array", items: { type: "string" }, description: "Files to stage, use ['.'] for all" },
          },
          required: ["repo", "files"],
        },
      },
      {
        name: "git_commit",
        description: "Commit staged files. Always uses GIT_AUTHOR_NAME='Dev-Lead Agent' GIT_AUTHOR_EMAIL='dev-lead@zennya.app'",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Short repo name" },
            message: { type: "string", description: "Commit message" },
          },
          required: ["repo", "message"],
        },
      },
      {
        name: "git_push",
        description: "Push commits to origin",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Short repo name" },
            branch: { type: "string", description: "Branch to push (default: current branch)" },
            force: { type: "boolean", default: false, description: "Force push with --force" },
          },
          required: ["repo"],
        },
      },
      {
        name: "git_merge",
        description: "Merge a branch into the current branch",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Short repo name" },
            branch: { type: "string", description: "Branch to merge in" },
            no_ff: { type: "boolean", default: true, description: "Use --no-ff flag (default true)" },
          },
          required: ["repo", "branch"],
        },
      },
      {
        name: "git_pull",
        description: "Pull and rebase from origin",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Short repo name" },
          },
          required: ["repo"],
        },
      },
      {
        name: "create_git_worktree",
        description: "Create an isolated git worktree for parallel work. Returns the worktree path and branch name.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Short repo name (resolved to /home/david/<repo>)" },
            base_branch: { type: "string", default: "main", description: "Branch to base the worktree on (default: main)" },
            worktree_id: { type: "string", description: "Optional identifier for the worktree (used in path and branch name). Auto-generated if omitted." },
          },
          required: ["repo"],
        },
      },
      {
        name: "delete_git_worktree",
        description: "Remove a git worktree and optionally delete its branch.",
        inputSchema: {
          type: "object",
          properties: {
            worktree_path: { type: "string", description: "Absolute path to the worktree to remove" },
            delete_branch: { type: "boolean", default: false, description: "Also delete the worktree's branch after removal" },
          },
          required: ["worktree_path"],
        },
      },
      {
        name: "list_git_worktrees",
        description: "List all active git worktrees for a repo.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Short repo name (resolved to /home/david/<repo>)" },
          },
          required: ["repo"],
        },
      },
      {
        name: "warm_cache_for_repos",
        description: "Pre-populate project_context_cache for one or more repos by fetching their Jira issues and Confluence root page from the projects table",
        inputSchema: {
          type: "object",
          properties: {
            repos: {
              type: "array",
              items: { type: "string" },
              description: "List of project_id values from the projects table. Defaults to all three if omitted.",
            },
          },
          required: [],
        },
      },
      {
        name: "chat_session",
        description: "Run a direct interactive chat message via Claude Code CLI (claude --print), streaming output to ops-db and returning the claude session ID for context continuity",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "User message to send to Claude" },
            session_id: { type: "string", description: "ops-db session ID (for logging to session feed)" },
            claude_session_id: { type: "string", description: "Existing Claude session ID to resume (omit or null for new session)" },
            working_dir: { type: "string", description: "Working directory (defaults to /home/david/dev-session-app)" },
          },
          required: ["message"],
        },
      },
      {
        name: "deploy_project",
        description: "Deploy a project by ID. Spawns a CLI agent (Sonnet) that inspects topology files, builds, deploys, and smoke-tests the project. Returns immediately with a task ID; smoke_status is 'pending' until the agent posts a checkpoint to the session feed.",
        inputSchema: {
          type: "object",
          properties: {
            project_id: {
              type: "string",
              description: "Project ID (matches projects table project_id)",
            },
            session_id: {
              type: "string",
              description: "Optional session ID to post progress messages to",
            },
          },
          required: ["project_id"],
        },
      },
      {
        name: "post_message",
        description: "Post a message to a session feed (inserts into session_messages and emits pg_notify). Use this to post status_change, approval_request, checkpoint, or console messages from dev-lead.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "The ops-db session ID" },
            role: {
              type: "string",
              enum: ["coding_agent", "dev_lead", "system"],
              default: "dev_lead",
              description: "Message role",
            },
            content: { type: "string", description: "Message content" },
            message_type: {
              type: "string",
              default: "status_change",
              description: "Message type: status_change | approval_request | checkpoint | execution_update | console | execution_log",
            },
            metadata: { type: "object", description: "Optional metadata (e.g. {complexity, question, options} for approval_request)" },
          },
          required: ["session_id", "content"],
        },
      },
      {
        name: "create_project",
        description: "Register a new project in the projects table (or update an existing one). Sets display name, description, build command, working directory, default container, Jira keys, Confluence root, and smoke URL. Auto-detects build command from the filesystem if not provided. Note: deploy_cmd is deprecated — deployment is handled by the CLI agent via deploy_project.",
        inputSchema: {
          type: "object",
          properties: {
            project_id: {
              type: "string",
              description: "Unique project identifier (e.g. 'my-api', 'ash-dashboard'). Used as PK in projects table.",
            },
            display_name: {
              type: "string",
              description: "Human-readable project name (e.g. 'Ash Dashboard')",
            },
            description: {
              type: "string",
              description: "Brief project description/context",
            },
            working_dir: {
              type: "string",
              description: "Absolute path to the project directory (e.g. /home/david/my-api). Auto-detected if omitted.",
            },
            default_container: {
              type: "string",
              description: "Default dev container name (e.g. 'dev-david')",
            },
            build_cmd: {
              type: "string",
              description: "Build command. Auto-detected from filesystem if omitted.",
            },
            smoke_url: {
              type: "string",
              description: "Health-check URL to verify deployment (e.g. https://app.example.com/health)",
            },
            jira_issue_keys: {
              type: "string",
              description: "Comma-separated parent Jira issue keys (e.g. 'ZI-18820,ZI-18821')",
            },
            confluence_root_id: {
              type: "string",
              description: "Confluence page ID for project documentation root",
            },
          },
          required: ["project_id"],
        },
      },
      {
        name: "transition_session",
        description: "Atomically transition a session's status with graph validation. Rejects invalid transitions (e.g. completed → executing). Uses optimistic concurrency to prevent races.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "The ops-db session ID" },
            to_status: {
              type: "string",
              enum: ["pending", "active", "executing", "awaiting_approval", "planning", "paused", "completed", "failed"],
              description: "Target status",
            },
          },
          required: ["session_id", "to_status"],
        },
      },
      {
        name: "get_session_provenance",
        description: "Get full provenance and timeline for a session: status, next allowed transitions, branch, worktree, Jira keys, cost, turn count, and message timeline.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "The ops-db session ID" },
          },
          required: ["session_id"],
        },
      },
      {
        name: "run_bootstrap_planning",
        description: "Trigger the CLI planning pass for a session. Dev-lead calls this after bootstrapping. The CLI reads the codebase, produces an implementation plan, and posts it as an approval_request. This is the ONLY way to start the planning pass — do not post approval_request directly.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "The ops-db session ID to run planning for" },
          },
          required: ["session_id"],
        },
      },
      {
        name: "get_container_inventory",
        description: "Get a full inventory of this container: version, active sessions, worktrees, tool registry, and health checks.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
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
          } = args as any;

          const dbUrl = ops_db_url || process.env.OPS_DB_URL;

          const taskId = task_id || randomUUID();
          taskLogs.set(taskId, []);
          const log = (line: string) => taskLogs.get(taskId)!.push(line);
          const debugLogPath = `/tmp/task-${taskId}-debug.log`;

          // Look up session's saved model if no explicit model override was given
          let resolvedModel = model || DEFAULT_MODEL;
          if (!model && session_id && dbUrl) {
            try {
              const row = await withDbClient(dbUrl, async (client) => {
                const r = await client.query<{ model: string | null }>(
                  "SELECT model FROM sessions WHERE session_id = $1",
                  [session_id]
                );
                return r.rows[0] ?? null;
              });
              if (row?.model) resolvedModel = row.model;
            } catch (_) { /* ignore — keep resolvedModel */ }
          }

          postToFeed(session_id, dbUrl, `🤖 Model: ${resolvedModel} | driver: ${driver} | effort: ${effort || "medium"} | task_id: ${taskId}`);

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

                // Build env with model-specific overrides
                const childEnv: Record<string, string | undefined> = {
                  ...process.env,
                  PATH: `/usr/bin:/usr/local/bin:/home/david/.npm-local/bin:${process.env.PATH ?? ""}`,
                  CLAUDECODE: undefined,
                  CLAUDE_CODE_ENTRYPOINT: undefined,
                  ...(( model || DEFAULT_MODEL).startsWith("glm") && !(model || DEFAULT_MODEL).endsWith("-coding") ? {
                    ANTHROPIC_BASE_URL: "http://localhost:4001",
                    ANTHROPIC_AUTH_TOKEN: "zai-bridge",
                  } : {}),
                  ...((model || DEFAULT_MODEL).endsWith("-coding") ? {
                    ANTHROPIC_BASE_URL: "http://localhost:4002",
                    ANTHROPIC_AUTH_TOKEN: "zai-bridge",
                  } : {}),
                  ...((model || DEFAULT_MODEL).startsWith("MiniMax") ? {
                    ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
                    ANTHROPIC_AUTH_TOKEN: process.env.MINIMAX_API_KEY,
                    ANTHROPIC_MODEL: model || "MiniMax-M2.7",
                    ANTHROPIC_SMALL_FAST_MODEL: model || "MiniMax-M2.7",
                    ANTHROPIC_DEFAULT_SONNET_MODEL: model || "MiniMax-M2.7",
                  } : {}),
                };
                if ((model || DEFAULT_MODEL).startsWith("MiniMax")) {
                    delete childEnv.ANTHROPIC_API_KEY;
                    delete childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL;
                    delete childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
                    delete childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL;
                }

                const proc = spawn(resolveClaudeBin(), claudeArgs, {
                  cwd: working_dir, env: childEnv as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] as const,
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
                      const parsed = JSON.parse(line);
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
                        output = parsed.result || parsed.output || JSON.stringify(parsed);
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
                          }).catch((err) => console.error('[token-usage] Failed to update token usage:', err));
                        }
                      } else if (parsed.type === "assistant") {
                        const content = parsed.message?.content || [];
                        for (const block of content) {
                          if (block.type === "tool_use") {
                            toolUseMap.set(block.id, block.name);
                            const toolInput = JSON.stringify(block.input || {}).slice(0, 500);
                            postToFeed(session_id, dbUrl, `🔧 \`${block.name}\` ${toolInput}`);
                          } else if (block.type === "thinking" && block.thinking?.trim()) {
                            postToFeed(session_id, dbUrl, `🧠 ${block.thinking.trim().slice(0, 600)}`);
                          } else if (block.type === "text" && block.text?.trim() && !parsed.message?.usage) {
                            const text = block.text.trim().slice(0, 1000);
                            if (text.length > 20) postToFeed(session_id, dbUrl, `💭 ${text}`);
                          }
                        }
                      } else if (parsed.type === "user") {
                        const content = parsed.message?.content || [];
                        for (const block of content) {
                          if (block.type === "tool_result") {
                            const toolName = toolUseMap.get(block.tool_use_id) || block.tool_use_id || "unknown";
                            let resultText = "";
                            if (typeof block.content === "string") resultText = block.content;
                            else if (Array.isArray(block.content)) resultText = block.content.map((c: any) => c.text || "").join("\n");
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
                proc.on("close", (code) => {
                  clearTimeout(timer);
                  try { fs.unlinkSync(rulesFile); } catch {}
                  postToFeed(session_id, dbUrl, `✅ Process ${taskId} exited with code ${code}. Debug log: ${debugLogPath}`);
                });
              } catch (err: any) {
                console.error(`[code_task] Error in async spawn: ${err.message}`);
                postToFeed(session_id, dbUrl, `❌ Task ${taskId} failed to start: ${err.message}`);
              }
            })().catch((err: any) => {
              console.error(`[code_task] Unhandled rejection: ${err.message}`);
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
                      const parsed = JSON.parse(line);
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
                proc.on("close", (code) => {
                  clearTimeout(timer);
                  try { fs.unlinkSync(clinerules); } catch {}
                  postToFeed(session_id, dbUrl, `✅ Process ${taskId} exited with code ${code}`);
                });
              } catch (err: any) {
                console.error(`[code_task] Error in async spawn: ${err.message}`);
                postToFeed(session_id, dbUrl, `❌ Task ${taskId} failed to start: ${err.message}`);
              }
            })().catch((err: any) => {
              console.error(`[code_task] Unhandled rejection: ${err.message}`);
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
          const { task_id } = args as any;
          const logs = taskLogs.get(task_id) || [];
          return { content: [{ type: "text", text: JSON.stringify({ task_id, lines: logs }) }] };
        }

        case "run_tests": {
          const { working_dir, test_cmd } = args as any;
          let cmd = test_cmd;
          if (!cmd) {
            try {
              const proj = JSON.parse(fs.readFileSync(path.join(working_dir, ".project.json"), "utf8"));
              cmd = proj.testCmd;
            } catch {}
          }
          if (!cmd) cmd = process.env.TEST_CMD || "npm test";
          const r = spawnSync(cmd, { shell: true, cwd: working_dir, encoding: "utf8" });
          const output = (r.stdout || "") + (r.stderr || "");
          return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
        }

        case "run_build": {
          const { working_dir, build_cmd } = args as any;
          let cmd = build_cmd;
          if (!cmd) {
            try {
              const proj = JSON.parse(fs.readFileSync(path.join(working_dir, ".project.json"), "utf8"));
              cmd = proj.buildCmd;
            } catch {}
          }
          if (!cmd) cmd = process.env.BUILD_CMD || "npm run build";
          const r = spawnSync(cmd, { shell: true, cwd: working_dir, encoding: "utf8" });
          const output = (r.stdout || "") + (r.stderr || "");
          return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
        }

        case "get_diff": {
          const { working_dir, from_ref = "HEAD", to_ref } = args as any;
          const diffArgs = to_ref ? `${from_ref} ${to_ref}` : from_ref;
          const r = spawnSync("git", ["diff", ...diffArgs.split(" ")], { cwd: working_dir, encoding: "utf8" });
          return { content: [{ type: "text", text: JSON.stringify({ output: r.stdout + r.stderr, exit_code: r.status ?? -1 }) }] };
        }

        case "get_repo_state": {
          const { working_dir } = args as any;
          const run = (gitArgs: string[]) => spawnSync("git", gitArgs, { cwd: working_dir, encoding: "utf8" });

          const branchR = run(["rev-parse", "--abbrev-ref", "HEAD"]);
          const branch = branchR.stdout.trim();
          const statusR = run(["status", "--short"]);
          const dirty = statusR.stdout.trim().length > 0;
          const stagedR = run(["diff", "--cached", "--name-only"]);
          const staged_files = stagedR.stdout.trim().split("\n").filter(Boolean);
          const logR = run(["log", "--oneline", "-10"]);
          const recent_commits = logR.stdout.trim().split("\n").filter(Boolean).map((line) => {
            const [hash, ...rest] = line.split(" ");
            return { hash, subject: rest.join(" ") };
          });

          return {
            content: [{
              type: "text",
              text: JSON.stringify({ branch, dirty, staged_files, recent_commits }),
            }],
          };
        }

        case "cache_read": {
          const { cache_key } = args as any;
          const dbUrl = process.env.OPS_DB_URL;
          const result = await withDbClient(dbUrl, async (client) => {
            const rowRes = await client.query<{
              summary: string;
              content_hash: string;
              source_updated: string | null;
              cached_at: string;
            }>(
              `SELECT summary, content_hash, source_updated, cached_at
               FROM project_context_cache
               WHERE cache_key = $1`,
              [cache_key]
            );
            if (rowRes.rows.length === 0) {
              return { found: false };
            }
            await client.query(
              `UPDATE project_context_cache SET last_checked = now() WHERE cache_key = $1`,
              [cache_key]
            );
            const row = rowRes.rows[0];
            return {
              found: true,
              summary: row.summary,
              content_hash: row.content_hash,
              source_updated: row.source_updated,
              cached_at: row.cached_at,
            };
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }

        case "cache_write": {
          const { cache_key, source_type, content_hash, source_updated = null, summary } = args as any;
          const dbUrl = process.env.OPS_DB_URL;
          await writeCacheEntry(dbUrl!, cache_key, source_type, content_hash, source_updated, summary);
          return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
        }

        case "listen_for_approval": {
          const { session_id, timeout_seconds = 1800 } = args as any;
          const dbUrl = process.env.OPS_DB_URL;
          const result = await withDbClient(dbUrl, async (client) => {
            const channel = `session:${session_id}`;
            const quotedChannel = `"${channel.replace(/"/g, '""')}"`;
            await client.query(`LISTEN ${quotedChannel}`);
            try {
              const notified = await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => {
                  client.removeListener("notification", onNotification);
                  resolve(false);
                }, Math.max(1, Number(timeout_seconds)) * 1000);

                const onNotification = (msg: { channel?: string }) => {
                  if (msg.channel === channel) {
                    clearTimeout(timer);
                    client.removeListener("notification", onNotification);
                    resolve(true);
                  }
                };

                client.on("notification", onNotification);
              });

              if (!notified) {
                return { approved: false, timed_out: true };
              }

              const approvalRes = await client.query<{ content: string }>(
                `SELECT content
                 FROM session_messages
                 WHERE session_id = $1
                   AND message_type = 'approval_response'
                   AND role != 'dev_lead'
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [session_id]
              );

              if (approvalRes.rows.length === 0) {
                return { approved: false };
              }
              return { approved: true, content: approvalRes.rows[0].content };
            } finally {
              await client.query(`UNLISTEN ${quotedChannel}`).catch(() => {});
            }
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }

        case "git_status": {
          const { repo } = args as any;
          const working_dir = `/home/david/${repo}`;
          const branchR = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: working_dir, encoding: "utf8" });
          const branch = branchR.stdout.trim();
          const statusR = spawnSync("git", ["status", "--short"], { cwd: working_dir, encoding: "utf8" });
          const staged: string[] = [];
          const unstaged: string[] = [];
          const untracked: string[] = [];
          for (const line of statusR.stdout.split("\n")) {
            if (!line) continue;
            const indexChar = line[0];
            const wtChar = line[1];
            const file = line.slice(3);
            if (indexChar === "?" && wtChar === "?") {
              untracked.push(file);
            } else {
              if (indexChar !== " " && indexChar !== "?") staged.push(file);
              if (wtChar !== " " && wtChar !== "?") unstaged.push(file);
            }
          }
          return { content: [{ type: "text", text: JSON.stringify({ branch, staged, unstaged, untracked, exit_code: branchR.status ?? -1 }) }] };
        }

        case "git_checkout": {
          const { repo, branch, create = false } = args as any;
          const working_dir = `/home/david/${repo}`;
          const gitArgs = create ? ["checkout", "-b", branch] : ["checkout", branch];
          const r = spawnSync("git", gitArgs, { cwd: working_dir, encoding: "utf8" });
          const output = (r.stdout || "") + (r.stderr || "");
          return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
        }

        case "git_add": {
          const { repo, files } = args as any;
          const working_dir = `/home/david/${repo}`;
          const r = spawnSync("git", ["add", ...files], { cwd: working_dir, encoding: "utf8" });
          const output = (r.stdout || "") + (r.stderr || "");
          return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
        }

        case "git_commit": {
          const { repo, message } = args as any;
          const working_dir = `/home/david/${repo}`;
          const gitEnv = {
            ...process.env,
            GIT_AUTHOR_NAME: "Dev-Lead Agent",
            GIT_AUTHOR_EMAIL: "dev-lead@zennya.app",
            GIT_COMMITTER_NAME: "Dev-Lead Agent",
            GIT_COMMITTER_EMAIL: "dev-lead@zennya.app",
          };
          const r = spawnSync("git", ["commit", "-m", message], { cwd: working_dir, encoding: "utf8", env: gitEnv });
          const output = (r.stdout || "") + (r.stderr || "");
          return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
        }

        case "git_push": {
          const { repo, branch, force = false } = args as any;
          const working_dir = `/home/david/${repo}`;
          const gitArgs = ["push"];
          if (force) gitArgs.push("--force");
          gitArgs.push("origin");
          if (branch) gitArgs.push(branch);
          const r = spawnSync("git", gitArgs, { cwd: working_dir, encoding: "utf8" });
          const output = (r.stdout || "") + (r.stderr || "");
          return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
        }

        case "git_merge": {
          const { repo, branch, no_ff = true } = args as any;
          const working_dir = `/home/david/${repo}`;
          const gitArgs = ["merge"];
          if (no_ff) gitArgs.push("--no-ff");
          gitArgs.push(branch);
          const r = spawnSync("git", gitArgs, { cwd: working_dir, encoding: "utf8" });
          const output = (r.stdout || "") + (r.stderr || "");
          return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
        }

        case "git_pull": {
          const { repo } = args as any;
          const working_dir = `/home/david/${repo}`;
          const r = spawnSync("git", ["pull", "--rebase", "origin"], { cwd: working_dir, encoding: "utf8" });
          const output = (r.stdout || "") + (r.stderr || "");
          return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
        }

        case "create_git_worktree": {
          const { repo, base_branch = "main", worktree_id } = args as any;
          const repoDir = `/home/david/${repo}`;
          const id = worktree_id || `wt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
          const worktreePath = `/tmp/${repo}-${id}`;
          const branchName = `worktree/${id}`;

          spawnSync("git", ["fetch", "origin", base_branch], { cwd: repoDir, encoding: "utf8" });

          const r = spawnSync("git", ["worktree", "add", "-b", branchName, worktreePath, `origin/${base_branch}`], {
            cwd: repoDir,
            encoding: "utf8",
          });
          const output = (r.stdout || "") + (r.stderr || "");
          if (r.status !== 0) {
            return { content: [{ type: "text", text: JSON.stringify({ success: false, output, exit_code: r.status ?? -1 }) }] };
          }
          return {
            content: [{ type: "text", text: JSON.stringify({
              success: true,
              worktree_path: worktreePath,
              branch: branchName,
              base_branch,
              repo_dir: repoDir,
              output,
            }) }],
          };
        }

        case "delete_git_worktree": {
          const { worktree_path, delete_branch = false } = args as any;

          let worktreeBranch: string | null = null;
          if (delete_branch) {
            const branchR = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree_path, encoding: "utf8" });
            worktreeBranch = branchR.status === 0 ? branchR.stdout.trim() : null;
          }

          const mainR = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: worktree_path, encoding: "utf8" });
          let mainRepoDir: string | null = null;
          if (mainR.status === 0) {
            const match = mainR.stdout.match(/^worktree (.+)$/m);
            if (match) mainRepoDir = match[1];
          }

          const removeR = spawnSync("git", ["worktree", "remove", worktree_path, "--force"], {
            cwd: mainRepoDir || worktree_path,
            encoding: "utf8",
          });
          const output = (removeR.stdout || "") + (removeR.stderr || "");

          let branchDeleted = false;
          if (delete_branch && worktreeBranch && mainRepoDir && removeR.status === 0) {
            const delR = spawnSync("git", ["branch", "-D", worktreeBranch], { cwd: mainRepoDir, encoding: "utf8" });
            branchDeleted = delR.status === 0;
          }

          return {
            content: [{ type: "text", text: JSON.stringify({
              success: removeR.status === 0,
              output,
              branch_deleted: branchDeleted,
              exit_code: removeR.status ?? -1,
            }) }],
          };
        }

        case "list_git_worktrees": {
          const { repo } = args as any;
          const repoDir = `/home/david/${repo}`;
          const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repoDir, encoding: "utf8" });
          if (r.status !== 0) {
            const output = (r.stdout || "") + (r.stderr || "");
            return { content: [{ type: "text", text: JSON.stringify({ success: false, output, exit_code: r.status ?? -1 }) }] };
          }

          const worktrees: Array<{ path: string; head: string; branch: string | null; bare: boolean; detached: boolean }> = [];
          let current: any = {};
          for (const line of r.stdout.split("\n")) {
            if (line.startsWith("worktree ")) {
              if (current.path) worktrees.push(current);
              current = { path: line.slice(9), head: "", branch: null, bare: false, detached: false };
            } else if (line.startsWith("HEAD ")) {
              current.head = line.slice(5);
            } else if (line.startsWith("branch ")) {
              current.branch = line.slice(7);
            } else if (line === "bare") {
              current.bare = true;
            } else if (line === "detached") {
              current.detached = true;
            }
          }
          if (current.path) worktrees.push(current);

          return { content: [{ type: "text", text: JSON.stringify({ success: true, worktrees }) }] };
        }

        case "chat_session": {
          const {
            message,
            session_id: chatSessionId,
            claude_session_id: existingClaudeSessionId,
            working_dir: chatWorkingDir = "/home/david/dev-session-app",
          } = args as any;

          const dbUrl = process.env.OPS_DB_URL ?? "";

          let systemContextFile: string | null = null;
          if (chatSessionId && dbUrl && !existingClaudeSessionId) {
            try {
              const bootstrapClient = new Client({ connectionString: dbUrl });
              await bootstrapClient.connect();

              const countRes = await bootstrapClient.query<{ count: string }>(
                "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = $1 AND role = 'user'",
                [chatSessionId]
              );
              const msgCount = parseInt(countRes.rows[0]?.count ?? "0", 10);

              if (msgCount <= 1) {
                const projRes = await bootstrapClient.query<{
                  display_name: string;
                  description: string;
                  project_id: string;
                  default_container: string;
                }>(
                  `SELECT p.display_name, p.description, p.project_id, p.default_container
                   FROM sessions s
                   JOIN projects p ON p.project_id = s.project_id
                   WHERE s.session_id = $1`,
                  [chatSessionId]
                );

                if (projRes.rows.length > 0) {
                  const proj = projRes.rows[0];
                  const repo = proj.project_id;
                  const contextMsg = `You are Claude Code running in an interactive dev session. Project: ${proj.display_name} (${repo}). Path: /home/david/${repo}. Container: ${proj.default_container}. Description: ${proj.description}. Help the developer with code questions, debugging, and changes in this project.`;

                  const bootstrapInsert = await bootstrapClient.query<{ message_id: string; created_at: string }>(
                    "INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING message_id, created_at",
                    [chatSessionId, "system", contextMsg, "system_context"]
                  );
                  if (bootstrapInsert.rows[0]) {
                    await notifySessionMessage(bootstrapClient, chatSessionId, {
                      id: bootstrapInsert.rows[0].message_id,
                      message_id: bootstrapInsert.rows[0].message_id,
                      session_id: chatSessionId,
                      role: "system",
                      message_type: "system_context",
                      content: contextMsg,
                      created_at: bootstrapInsert.rows[0].created_at,
                    }).catch(() => {});
                  }

                  systemContextFile = `/tmp/container-mcp-ctx-${chatSessionId}.md`;
                  fs.writeFileSync(systemContextFile, contextMsg);
                  console.log(`[chat_session] bootstrap context injected for session ${chatSessionId} (project: ${repo})`);
                }
              }

              await bootstrapClient.end().catch(() => {});
            } catch (e: any) {
              console.warn("[chat_session] bootstrap error:", e.message);
            }
          }

          // Resolve model: use session's saved model if available, else DEFAULT_MODEL
          let chatModel = DEFAULT_MODEL;
          if (chatSessionId && dbUrl) {
            try {
              const row = await withDbClient(dbUrl, async (client) => {
                const r = await client.query<{ model: string | null }>(
                  "SELECT model FROM sessions WHERE session_id = $1",
                  [chatSessionId]
                );
                return r.rows[0] ?? null;
              });
              if (row?.model) chatModel = row.model;
            } catch (_) { /* ignore — keep DEFAULT_MODEL */ }
          }

          const claudeArgs = [
            "-p", message,
            "--output-format", "stream-json",
            "--verbose",
            "--model", chatModel,
          ];

          if (existingClaudeSessionId) {
            claudeArgs.push("--resume", existingClaudeSessionId);
          }

          if (systemContextFile) {
            claudeArgs.push("--append-system-prompt-file", systemContextFile);
          }

          const chatResult = await new Promise<{
            claude_session_id: string | null;
            response: string;
            tokens_used: number;
          }>((resolve) => {
            const proc = spawn(resolveClaudeBin(), claudeArgs, {
              cwd: chatWorkingDir,
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"] as const,
            });

            let fullAssistantText = "";
            let resultClaudeSessionId: string | null = null;
            let tokensUsed = 0;
            let costUsd = 0;

            const timer = setTimeout(() => {
              proc.kill("SIGTERM");
            }, 600_000);

            proc.stdout.on("data", (chunk: Buffer) => {
              const lines = chunk.toString().split("\n");
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const parsed = JSON.parse(line);

                  if (parsed.type === "assistant") {
                    const content = parsed.message?.content || [];
                    for (const block of content) {
                      if (block.type === "text" && block.text?.trim()) {
                        const text = block.text.trim();
                        fullAssistantText += text + "\n";
                        if (chatSessionId && text.length > 0) {
                          void (async () => {
                            if (!chatSessionId || !dbUrl) return;
                            const key = `${chatSessionId}::${dbUrl}`;
                            if (!_feedClients.has(key)) {
                              const client = new Client({ connectionString: dbUrl });
                              await client.connect();
                              _feedClients.set(key, { client, queue: Promise.resolve() });
                            }
                            const entry = _feedClients.get(key)!;
                            entry.queue = entry.queue.then(async () => {
                              try {
                                const insertRes = await entry.client.query<{ message_id: string; created_at: string }>(
                                  "INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING message_id, created_at",
                                  [chatSessionId, "coding_agent", text, "execution_log"]
                                );
                                if (insertRes.rows[0]) {
                                  await notifySessionMessage(entry.client, chatSessionId, {
                                    id: insertRes.rows[0].message_id,
                                    message_id: insertRes.rows[0].message_id,
                                    session_id: chatSessionId,
                                    role: "coding_agent",
                                    message_type: "execution_log",
                                    content: text,
                                    created_at: insertRes.rows[0].created_at,
                                  }).catch(() => {});
                                }
                              } catch (e: any) {
                                console.error("chat_session postToFeed error:", e.message);
                              }
                            });
                          })();
                        }
                      } else if (block.type === "tool_use" && chatSessionId && dbUrl) {
                        postToFeed(chatSessionId, dbUrl, `🔧 \`${block.name}\` ${JSON.stringify(block.input || {}).slice(0, 200)}`, "coding_agent", "execution_log");
                      }
                    }
                  } else if (parsed.type === "result") {
                    resultClaudeSessionId = (parsed.session_id as string) || null;
                    if (parsed.usage) {
                      const inputTokens = parsed.usage.input_tokens || 0;
                      const outputTokens = parsed.usage.output_tokens || 0;
                      tokensUsed = inputTokens + outputTokens;
                      const { input: inputCostPerM, output: outputCostPerM } = modelCostPerMillion();
                      costUsd = (inputTokens / 1_000_000 * inputCostPerM) + (outputTokens / 1_000_000 * outputCostPerM);
                    }
                    const resultText = (parsed.result || parsed.output || "") as string;
                    if (resultText && chatSessionId && dbUrl) {
                      postToFeed(chatSessionId, dbUrl, `✅ Done`, "coding_agent", "execution_log");
                    }
                  }
                } catch {
                  // ignore malformed JSON lines
                }
              }
            });

            proc.stderr.on("data", (chunk: Buffer) => {
              console.error("[chat_session] stderr:", chunk.toString().slice(0, 200));
            });

            proc.on("close", (code) => {
              clearTimeout(timer);
              if (systemContextFile) {
                try { fs.unlinkSync(systemContextFile); } catch {}
              }
              if (chatSessionId && fullAssistantText.trim()) {
                void (async () => {
                  if (!chatSessionId || !dbUrl) return;
                  const key = `${chatSessionId}::${dbUrl}`;
                  if (!_feedClients.has(key)) {
                    const client = new Client({ connectionString: dbUrl });
                    await client.connect();
                    _feedClients.set(key, { client, queue: Promise.resolve() });
                  }
                  const entry = _feedClients.get(key)!;
                  entry.queue = entry.queue.then(async () => {
                    try {
                      const insertRes = await entry.client.query<{ message_id: string; created_at: string }>(
                        "INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING message_id, created_at",
                        [chatSessionId, "coding_agent", fullAssistantText.trim(), "chat"]
                      );
                      if (insertRes.rows[0]) {
                        await notifySessionMessage(entry.client, chatSessionId, {
                          id: insertRes.rows[0].message_id,
                          message_id: insertRes.rows[0].message_id,
                          session_id: chatSessionId,
                          role: "coding_agent",
                          message_type: "chat",
                          content: fullAssistantText.trim(),
                          created_at: insertRes.rows[0].created_at,
                        }).catch(() => {});
                      }
                    } catch (e: any) {
                      console.error("chat_session final chat error:", e.message);
                    }
                  });
                  if (resultClaudeSessionId) {
                    entry.queue = entry.queue.then(async () => {
                      try {
                        await entry.client.query(
                          "UPDATE sessions SET claude_session_id = $1, updated_at = now() WHERE session_id = $2",
                          [resultClaudeSessionId, chatSessionId]
                        );
                      } catch (e: any) {
                        console.error("chat_session update claude_session_id error:", e.message);
                      }
                    });
                  }
                })();
              }
              if (tokensUsed > 0 && chatSessionId && dbUrl) {
                void withDbClient(dbUrl, async (client) => {
                  await client.query(
                    `UPDATE sessions SET token_usage = COALESCE(token_usage, 0) + $1, cost_usd = COALESCE(cost_usd, 0) + $2 WHERE session_id = $3`,
                    [tokensUsed, costUsd, chatSessionId]
                  );
                }).catch((err) => console.error('[token-usage] Failed to update token usage:', err));
              }
              resolve({
                claude_session_id: resultClaudeSessionId,
                response: fullAssistantText.trim(),
                tokens_used: tokensUsed,
              });
            });
          });

          return {
            content: [{ type: "text", text: JSON.stringify(chatResult) }],
          };
        }

        case "warm_cache_for_repos": {
          const { repos: targetRepos } = args as any;
          const repoList: string[] = Array.isArray(targetRepos) && targetRepos.length > 0
            ? targetRepos
            : ["dev-session-app", "container-mcp", "ash-dashboard"];
          const dbUrl = process.env.OPS_DB_URL;
          if (!dbUrl) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
          }
          const results: Record<string, string> = {};
          for (const repoId of repoList) {
            try {
              const projRow = await withDbClient(dbUrl, async (client) => {
                const r = await client.query<{
                  confluence_root_id: string | null;
                }>(
                  `SELECT confluence_root_id FROM projects WHERE project_id = $1`,
                  [repoId]
                );
                return r.rows[0] ?? null;
              });
              if (!projRow) {
                results[repoId] = "not found in projects table";
                continue;
              }
              const confluenceRootId = projRow.confluence_root_id ?? null;
              await populateCacheForProject(dbUrl, [], confluenceRootId);
              results[repoId] = `ok (confluence: ${confluenceRootId ?? "none"})`;
            } catch (e: any) {
              results[repoId] = `error: ${e.message}`;
            }
          }
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, results }) }] };
        }

        case "deploy_project": {
          const { project_id, session_id: deploySessionId } = args as { project_id: string; session_id?: string };
          const result = await deployProject(project_id, deploySessionId);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "post_message": {
          const { session_id: pmSessionId, role: pmRole = "dev_lead", content: pmContent, message_type: pmMsgType = "status_change", metadata: pmMetadata } = args as any;
          const dbUrl = process.env.OPS_DB_URL;
          if (!dbUrl) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
          const row = await withDbClient(dbUrl, async (client) => {
            const metadataJson = pmMetadata ? JSON.stringify(pmMetadata) : null;
            const insertRes = await client.query<{ message_id: string; created_at: string }>(
              `INSERT INTO session_messages (message_id, session_id, role, content, message_type, metadata, created_at)
               VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, now())
               RETURNING message_id, created_at`,
              [pmSessionId, pmRole, pmContent, pmMsgType, metadataJson]
            );
            const inserted = insertRes.rows[0];
            if (inserted) {
              const notifyPayload = JSON.stringify({
                id: inserted.message_id, message_id: inserted.message_id,
                session_id: pmSessionId, role: pmRole, message_type: pmMsgType,
                content: pmContent, created_at: inserted.created_at,
              });
              const safeId = pmSessionId.replace(/-/g, "_");
              await client.query("SELECT pg_notify($1, $2)", [`session_messages_${safeId}`, notifyPayload]).catch(() => {});
              await client.query("SELECT pg_notify($1, $2)", [`session_messages`, notifyPayload]).catch(() => {});
              await client.query("SELECT pg_notify($1, $2)", [`session:${pmSessionId}`, notifyPayload]).catch(() => {});
            }
            return inserted;
          });
          // Auto-transition session status based on message type
          if (pmSessionId && dbUrl) {
            try {
              if (pmMsgType === "approval_request") {
                await transitionSession(dbUrl, pmSessionId, "awaiting_approval");
              } else if (pmMsgType === "checkpoint" && pmRole === "coding_agent") {
                // coding_agent checkpoint = execution done, back to active for dev-lead close-out
                await transitionSession(dbUrl, pmSessionId, "active");
              }
            } catch (_) { /* non-fatal */ }
          }
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, message_id: row?.message_id }) }] };
        }

        case "create_project": {
          const {
            project_id: projectId,
            display_name,
            description: projDescription,
            working_dir: inputWorkingDir,
            default_container,
            build_cmd: inputBuildCmd,
            smoke_url: inputSmokeUrl,
            jira_issue_keys: jiraKeysStr,
            confluence_root_id,
          } = args as any;

          const dbUrl = process.env.OPS_DB_URL;
          if (!dbUrl) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
          }

          let workingDir = inputWorkingDir || null;
          if (!workingDir) {
            for (const candidate of [`/home/david/${projectId}`, `/home/openclaw/apps/${projectId}`, `/opt/${projectId}`]) {
              if (fs.existsSync(candidate)) { workingDir = candidate; break; }
            }
          }

          let buildCmd = inputBuildCmd || null;
          const deployCmd: string | null = null; // deprecated — deploy_project uses CLI agent topology detection
          if (workingDir && !buildCmd) {
            const hasSwarmYml = fs.existsSync(path.join(workingDir, 'swarm.yml'));
            const hasDockerfile = fs.existsSync(path.join(workingDir, 'Dockerfile'));
            const hasPkgJson = fs.existsSync(path.join(workingDir, 'package.json'));
            const hasRequirements = fs.existsSync(path.join(workingDir, 'requirements.txt'));
            const hasPyproject = fs.existsSync(path.join(workingDir, 'pyproject.toml'));

            let detectedBuild: string | null = null;
            if (hasSwarmYml || hasDockerfile) {
              detectedBuild = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
            } else if (hasPkgJson) {
              detectedBuild = `cd ${workingDir} && npm install && npm run build`;
            } else if (hasRequirements || hasPyproject) {
              detectedBuild = `cd ${workingDir} && pip install -r ${hasRequirements ? 'requirements.txt' : '.'} -q`;
            }
            buildCmd = detectedBuild;
          }

          const jiraKeysArr = jiraKeysStr
            ? `{${jiraKeysStr.split(",").map((k: string) => k.trim()).filter(Boolean).join(",")}}`
            : null;

          try {
            await withDbClient(dbUrl, async (client) => {
              await client.query(
                `INSERT INTO projects (project_id, display_name, description, working_dir, default_container, build_cmd, deploy_cmd, smoke_url, jira_issue_keys, confluence_root_id, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, now(), now())
                 ON CONFLICT (project_id) DO UPDATE SET
                   display_name = COALESCE(EXCLUDED.display_name, projects.display_name),
                   description = COALESCE(EXCLUDED.description, projects.description),
                   working_dir = COALESCE(EXCLUDED.working_dir, projects.working_dir),
                   default_container = COALESCE(EXCLUDED.default_container, projects.default_container),
                   build_cmd = COALESCE(EXCLUDED.build_cmd, projects.build_cmd),
                   deploy_cmd = COALESCE(EXCLUDED.deploy_cmd, projects.deploy_cmd),
                   smoke_url = COALESCE(EXCLUDED.smoke_url, projects.smoke_url),
                   jira_issue_keys = COALESCE(EXCLUDED.jira_issue_keys, projects.jira_issue_keys),
                   confluence_root_id = COALESCE(EXCLUDED.confluence_root_id, projects.confluence_root_id),
                   updated_at = now()`,
                [projectId, display_name || null, projDescription || null, workingDir, default_container || null, buildCmd, deployCmd, inputSmokeUrl || null, jiraKeysArr, confluence_root_id || null]
              );
            });

            const row = await withDbClient(dbUrl, async (client) => {
              const r = await client.query(
                `SELECT project_id, display_name, description, working_dir, default_container, build_cmd, deploy_cmd, smoke_url, jira_issue_keys, confluence_root_id, created_at, updated_at FROM projects WHERE project_id = $1`,
                [projectId]
              );
              return r.rows[0] ?? null;
            });

            return { content: [{ type: "text", text: JSON.stringify({ ok: true, project: row }) }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
          }
        }

        case "transition_session": {
          const { session_id: tsSessionId, to_status } = args as { session_id: string; to_status: string };
          const dbUrl = process.env.OPS_DB_URL;
          if (!dbUrl) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }], isError: true };
          const result = await transitionSession(dbUrl, tsSessionId, to_status as SessionStatus);
          return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok };
        }

        case "run_bootstrap_planning": {
          // Dev-lead calls this to trigger the CLI planning pass.
          // Builds the bootstrap instruction and spawns a code_task in planning mode.
          const { session_id: bpSessionId } = args as { session_id: string };
          const dbUrl = process.env.OPS_DB_URL;
          if (!dbUrl) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }], isError: true };
          if (!bpSessionId) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "session_id required" }) }], isError: true };

          // Guard: don't double-spawn if planning is already active
          const alreadyPlanning = await withDbClient(dbUrl, async (c) => {
            const r = await c.query<{ count: string }>(
              `SELECT count(*) FROM session_messages WHERE session_id = $1 AND message_type = 'approval_request' AND role = 'coding_agent'`,
              [bpSessionId]
            );
            return parseInt(r.rows[0]?.count ?? "0", 10) > 0;
          }).catch(() => false);
          if (alreadyPlanning) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, skipped: true, reason: "approval_request already exists — planning already ran" }) }] };
          }

          const activeTask = await withDbClient(dbUrl, async (c) => {
            const r = await c.query<{ active_task_id: string | null }>(
              `SELECT active_task_id FROM sessions WHERE session_id = $1`,
              [bpSessionId]
            );
            return r.rows[0]?.active_task_id ?? null;
          }).catch(() => null);
          if (activeTask) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, skipped: true, reason: `planning task already running: ${activeTask}` }) }] };
          }

          try {
            const { buildBootstrapInstruction } = await import("./bootstrap.js");
            const { instruction, workingDir, allowedTools, model } = await buildBootstrapInstruction(bpSessionId, dbUrl);
            spawnCodeTask({ instruction, workingDir, sessionId: bpSessionId, dbUrl, allowedTools, model });
            postToFeed(bpSessionId, dbUrl, "🧠 CLI planning pass started — exploring codebase and generating implementation plan...");
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, session_id: bpSessionId, status: "planning_pass_spawned" }) }] };
          } catch (e: any) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
          }
        }

        case "get_session_provenance": {
          const { session_id: provSessionId } = args as { session_id: string };
          const dbUrl = process.env.OPS_DB_URL;
          if (!dbUrl) return { content: [{ type: "text", text: JSON.stringify({ error: "OPS_DB_URL not set" }) }], isError: true };

          const data = await withDbClient(dbUrl, async (client) => {
            const sessionRes = await client.query<{
              session_id: string; project_id: string; status: string;
              branch: string | null; worktree_path: string | null;
              jira_issue_keys: string[] | null; model: string | null;
              num_turns: number | null; cost_usd: string | null; created_at: string;
            }>(
              `SELECT session_id, project_id, status, branch, worktree_path,
                      jira_issue_keys, model, num_turns, cost_usd, created_at
               FROM sessions WHERE session_id = $1`,
              [provSessionId],
            );
            if (sessionRes.rows.length === 0) return null;

            const messagesRes = await client.query<{
              message_type: string; role: string; created_at: string; content: string;
            }>(
              `SELECT message_type, role, created_at, content
               FROM session_messages WHERE session_id = $1
               ORDER BY created_at ASC LIMIT 100`,
              [provSessionId],
            );
            return { session: sessionRes.rows[0], messages: messagesRes.rows };
          });

          if (!data) return { content: [{ type: "text", text: JSON.stringify({ error: `Session not found: ${provSessionId}` }) }], isError: true };

          const allowed = await nextAllowedActions(dbUrl, provSessionId);
          const timeline = data.messages.map((m) => ({
            message_type: m.message_type, role: m.role,
            created_at: m.created_at, content_preview: m.content.slice(0, 200),
          }));

          return { content: [{ type: "text", text: JSON.stringify({
            ...data.session,
            cost_usd: data.session.cost_usd ? parseFloat(data.session.cost_usd) : null,
            next_allowed_transitions: allowed,
            timeline,
          }) }] };
        }

        case "get_container_inventory": {
          const dbUrl = process.env.OPS_DB_URL;

          // Build lightweight tool registry from the tool list
          const toolNames = [
            "code_task", "get_task_log", "run_tests", "run_build",
            "git_status", "git_checkout", "git_add", "git_commit", "git_push", "git_merge", "git_pull",
            "create_git_worktree", "delete_git_worktree", "list_git_worktrees", "get_diff", "get_repo_state",
            "chat_session", "listen_for_approval", "post_message",
            "create_project", "deploy_project", "warm_cache_for_repos",
            "cache_read", "cache_write",
            "run_bootstrap_planning", "transition_session", "get_session_provenance", "get_container_inventory",
          ];

          let active_sessions: unknown[] = [];
          let worktrees: unknown[] = [];
          let db_health: "ok" | "error" = "error";

          if (dbUrl) {
            try {
              const result = await withDbClient(dbUrl, async (client) => {
                await client.query("SELECT 1");
                db_health = "ok";
                const sessRes = await client.query<{
                  session_id: string; project_id: string; status: string;
                  active_task_id: string | null; branch: string | null;
                }>(
                  `SELECT session_id, project_id, status, active_task_id, branch
                   FROM sessions WHERE active_task_id IS NOT NULL
                   ORDER BY updated_at DESC LIMIT 20`,
                );
                const wtRes = await client.query<{
                  session_id: string; worktree_path: string; branch: string;
                }>(
                  `SELECT session_id, worktree_path, branch
                   FROM sessions WHERE worktree_path IS NOT NULL AND status NOT IN ('completed', 'failed')
                   ORDER BY updated_at DESC LIMIT 50`,
                );
                return { sessions: sessRes.rows, worktrees: wtRes.rows };
              });
              active_sessions = result.sessions;
              worktrees = result.worktrees;
            } catch {
              db_health = "error";
            }
          }

          let gateway_health: "ok" | "error" = "error";
          const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://172.17.0.1:18789";
          try {
            const resp = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(3000) });
            gateway_health = resp.ok ? "ok" : "error";
          } catch {
            gateway_health = "error";
          }

          return { content: [{ type: "text", text: JSON.stringify({
            container_version: "2.2.0",
            tool_count: toolNames.length,
            tools: toolNames,
            active_sessions,
            worktrees,
            health: { db: db_health, gateway: gateway_health },
          }) }] };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err: any) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  return server;
}
