import { randomUUID } from "crypto";
import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { withDbClient } from "./db.js";
import { postToFeed } from "./feed.js";
import { taskLogs } from "./task-logs.js";

/**
 * Kill stale claude/node processes and reap zombies before spawning a new task.
 * Without this, defunct processes accumulate in the container and block new spawns.
 */
function cleanupStaleProcesses(): void {
  try {
    // Reap any zombie (defunct) processes by waiting on them
    try { execSync("kill -0 1 2>/dev/null && waitpid -e 2>/dev/null || true", { timeout: 3000 }); } catch {}

    // Find and kill orphaned claude CLI processes (not our parent MCP server)
    // Only target 'claude' processes that are children of PID 1 (orphaned)
    try {
      const stale = execSync(
        "ps -eo pid,ppid,stat,args 2>/dev/null | grep -E '(claude.*--output-format|[n]ode.*claude)' | grep -v grep || true",
        { timeout: 5000, encoding: "utf8" }
      ).trim();
      if (stale) {
        const pids: number[] = [];
        for (const line of stale.split("\n")) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[0], 10);
          const stat = parts[2] || "";
          // Kill zombies (Z) and orphaned processes (ppid=1)
          if (pid && (stat.includes("Z") || parts[1] === "1")) {
            pids.push(pid);
          }
        }
        if (pids.length > 0) {
          console.log(`[cleanupStaleProcesses] Killing ${pids.length} stale process(es): ${pids.join(", ")}`);
          for (const pid of pids) {
            try { process.kill(pid, "SIGKILL"); } catch {}
          }
        }
      }
    } catch {}

    // Final zombie reap pass — send SIGCHLD to init so it can clean up
    try { execSync("kill -s SIGCHLD 1 2>/dev/null || true", { timeout: 2000 }); } catch {}
  } catch (err) {
    console.warn(`[cleanupStaleProcesses] Non-fatal error: ${err}`);
  }
}

export function spawnCodeTask(params: {
  instruction: string;
  workingDir: string;
  sessionId?: string;
  dbUrl?: string;
  maxTurns?: number;
  budgetUsd?: number;
  timeoutSeconds?: number;
  model?: string;
  effort?: string;
  agents?: string;
  allowedTools?: string[];
  resumeClaudeSessionId?: string;
  taskRules?: string;
}): string {
  const {
    instruction, workingDir, sessionId, dbUrl,
    maxTurns = 40, budgetUsd = 8.0, timeoutSeconds = 1200,
    model, effort, agents, allowedTools, resumeClaudeSessionId, taskRules,
  } = params;

  const taskId = randomUUID();
  taskLogs.set(taskId, []);
  const log = (line: string) => taskLogs.get(taskId)!.push(line);
  const debugLogPath = `/tmp/task-${taskId}-debug.log`;

  postToFeed(sessionId!, dbUrl!, `🚀 Starting code task (${taskId})${model ? ` [${model}]` : ""}${resumeClaudeSessionId ? " [resumed]" : ""}\n\n${instruction.slice(0, 400)}`);

  (async () => {
    try {
      // Clean up stale processes from prior tasks before spawning
      cleanupStaleProcesses();

      // Build rules from base + project + task-specific
      const rulesFile = `/tmp/container-mcp-rules-${taskId}.md`;
      let rules = "";
      try { rules += fs.readFileSync("/home/david/.rules/base.md", "utf8") + "\n"; } catch {}
      try { rules += fs.readFileSync(path.join(workingDir, ".rules/project.md"), "utf8") + "\n"; } catch {}
      if (taskRules) rules += taskRules + "\n";
      fs.writeFileSync(rulesFile, rules);

      const claudeArgs: string[] = [
        "-p", instruction,
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--append-system-prompt-file", rulesFile,
        "--permission-mode", "acceptEdits",
        "--max-turns", String(maxTurns),
        "--max-budget-usd", String(budgetUsd),
        "--dangerously-skip-permissions",
        "--debug-file", debugLogPath,
      ];

      if (model) claudeArgs.push("--model", model);
      if (effort) claudeArgs.push("--effort", effort);
      if (agents) claudeArgs.push("--agents", agents);
      if (allowedTools && allowedTools.length > 0) claudeArgs.push("--allowed-tools", allowedTools.join(","));
      if (resumeClaudeSessionId) claudeArgs.push("--resume", resumeClaudeSessionId);

      const proc = spawn("claude", claudeArgs, {
        cwd: workingDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] as const,
      });

      const timer = setTimeout(() => { proc.kill("SIGTERM"); }, timeoutSeconds * 1000);

      proc.stdout.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          log(line);
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "result") {
              // Persist the claude session ID so EXECUTION pass can resume it
              const claudeSessionId = parsed.session_id as string | undefined;
              if (claudeSessionId && sessionId && dbUrl) {
                void withDbClient(dbUrl, async (client) => {
                  await client.query(
                    `UPDATE sessions SET claude_session_id = $1, updated_at = now() WHERE session_id = $2`,
                    [claudeSessionId, sessionId]
                  ).catch(() => {});
                });
              }
              const output = (parsed.result || parsed.output || "") as string;
              postToFeed(sessionId!, dbUrl!, `✅ Task complete\n\n${output.slice(0, 4000)}`);
              const usage = parsed.usage as { input_tokens?: number; output_tokens?: number } | undefined;
              if (usage && sessionId && dbUrl) {
                const inputTokens = usage.input_tokens || 0;
                const outputTokens = usage.output_tokens || 0;
                const costUsd = (inputTokens / 1_000_000 * 3) + (outputTokens / 1_000_000 * 15);
                void withDbClient(dbUrl, async (client) => {
                  await client.query(
                    `UPDATE sessions SET token_usage = COALESCE(token_usage, 0) + $1, cost_usd = COALESCE(cost_usd, 0) + $2 WHERE session_id = $3`,
                    [inputTokens + outputTokens, costUsd, sessionId]
                  );
                }).catch((err) => console.error("[token-usage] Failed:", err));
              }
            } else if (parsed.type === "assistant") {
              for (const block of (parsed.message?.content || [])) {
                if (block.type === "tool_use") {
                  postToFeed(sessionId!, dbUrl!, `🔧 \`${block.name}\` ${JSON.stringify(block.input || {}).slice(0, 500)}`);
                } else if (block.type === "text" && block.text?.trim() && !parsed.message?.usage) {
                  const text = block.text.trim().slice(0, 1000);
                  if (text.length > 20) postToFeed(sessionId!, dbUrl!, `💭 ${text}`);
                }
              }
            } else if (parsed.type === "tool_result") {
              const resultText = (parsed.content?.[0]?.text || "").slice(0, 2000);
              if (resultText) postToFeed(sessionId!, dbUrl!, `📄 Result: ${resultText}`);
            }
          } catch {}
        }
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        log("[stderr] " + text);
        // Surface non-trivial stderr to session feed (auth errors, crashes)
        if (text.includes("Error") || text.includes("error") || text.includes("failed")) {
          postToFeed(sessionId!, dbUrl!, `⚠️ stderr: ${text.slice(0, 500)}`, "system", "console");
        }
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        try { fs.unlinkSync(rulesFile); } catch {}
        postToFeed(sessionId!, dbUrl!, `✅ Process ${taskId} exited with code ${code}. Debug log: ${debugLogPath}`);
        console.log(`[spawnCodeTask] task ${taskId} done (code ${code}), debug log at ${debugLogPath}`);
        // Reap any orphaned child processes left behind by Claude CLI
        cleanupStaleProcesses();
      });
    } catch (err: any) {
      console.error(`[spawnCodeTask] Error: ${err.message}`);
      postToFeed(sessionId!, dbUrl!, `❌ Task ${taskId} failed to start: ${err.message}`);
    }
  })().catch((err: any) => console.error(`[spawnCodeTask] Unhandled rejection: ${err.message}`));

  return taskId;
}
