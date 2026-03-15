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
import { withDbClient, notifySessionMessage, buildSpawnMessage } from "./db.js";
import { postToFeed, _feedClients } from "./feed.js";
import { taskLogs } from "./task-logs.js";
import { populateCacheForProject, writeCacheEntry } from "./jira-confluence.js";
import { bootstrapSession } from "./bootstrap.js";
import { deployProject } from "./tools/deploy-project.js";

export function createMcpServer() {
  const server = new Server(
    { name: "container-mcp", version: "2.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
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
      },
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
        name: "spawn_dev_lead",
        description: "Spawn a dev-lead agent session via the OpenClaw gateway for a given ops-db session ID",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "The ops-db session ID to spawn a dev-lead for" },
          },
          required: ["session_id"],
        },
      },
      {
        name: "create_session",
        description: "Atomically create a dev session: INSERT into sessions table, INSERT task_brief into session_messages, and spawn dev-lead. Returns { ok, session_id, session_url }.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short title for the session" },
            repo: { type: "string", description: "Repository name (must match projects table project_id)" },
            container: { type: "string", description: "Dev container name (default: dev-david)" },
            task_brief: { type: "string", description: "Full task brief content to post as task_brief message" },
            slack_thread_url: { type: "string", description: "Slack thread URL for notifications (optional)" },
            jira_keys: { type: "string", description: "Comma-separated Jira issue keys (optional, e.g. ZI-18820)" },
          },
          required: ["title", "repo", "task_brief"],
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
        description: "Deploy a project by ID. Reads build_cmd/deploy_cmd/smoke_url from projects table. Auto-detects deploy type for new projects. Runs build, deploy, smoke test with 12 retries. Posts result to session feed.",
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
        description: "Register a new project in the projects table (or update an existing one). Sets display name, description, build/deploy commands, working directory, default container, Jira keys, Confluence root, and smoke URL. Auto-detects build/deploy commands from the filesystem if not provided.",
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
            deploy_cmd: {
              type: "string",
              description: "Deploy command. Auto-detected from filesystem if omitted.",
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
        name: "bootstrap_session",
        description: "Orchestrate a new dev session end-to-end. Resolves the project (exact match on project_id or project_hint), checks for existing active session, warms Jira/Confluence cache, creates/finds Jira issue, composes task brief, creates session record, and launches BOOTSTRAP planning pass via Claude Code CLI. If no project matches and no project_id is provided, returns needs_project=true with available_projects — the caller should then pick or create a project_id and call again.",
        inputSchema: {
          type: "object",
          properties: {
            user_request: {
              type: "string",
              description: "Natural-language description of what the user wants to do",
            },
            user_id: {
              type: "string",
              description: "User identifier (e.g. Slack user ID or email)",
            },
            project_id: {
              type: "string",
              description: "Explicit project_id. If it matches an existing project, that project is used. If it doesn't exist, a new project is auto-created with the given display_name/description. If omitted, the server tries to match from project_hint.",
            },
            project_hint: {
              type: "string",
              description: "Optional project_id or display_name to match against existing projects (exact, case-insensitive). Ignored if project_id is provided.",
            },
            display_name: {
              type: "string",
              description: "Display name for auto-created projects (e.g. 'Ash Dashboard'). Only used when project_id is new.",
            },
            description: {
              type: "string",
              description: "Description for auto-created projects. Only used when project_id is new.",
            },
            slack_thread_url: {
              type: "string",
              description: "Slack thread URL to associate with the session (optional)",
            },
          },
          required: ["user_request", "user_id"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
      switch (name) {
        case "code_task": {
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

          postToFeed(session_id, dbUrl, `🚀 Starting \`code_task\` (driver: ${driver}, task_id: ${taskId}${model ? `, model: ${model}` : ""}${resume_claude_session_id ? ", resumed" : ""})\n\nInstruction: ${instruction.slice(0, 400)}`);

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

                if (model) claudeArgs.push("--model", model);
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

                let output = "";
                const timer = setTimeout(() => { proc.kill("SIGTERM"); }, timeout_seconds * 1000);

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
                          const costUsd = (inputTokens / 1_000_000 * 3) + (outputTokens / 1_000_000 * 15);
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
                            const toolInput = JSON.stringify(block.input || {}).slice(0, 500);
                            postToFeed(session_id, dbUrl, `🔧 \`${block.name}\` ${toolInput}`);
                          } else if (block.type === "text" && block.text?.trim() && !parsed.message?.usage) {
                            const text = block.text.trim().slice(0, 1000);
                            if (text.length > 20) postToFeed(session_id, dbUrl, `💭 ${text}`);
                          }
                        }
                      } else if (parsed.type === "tool_result") {
                        const resultText = (parsed.content?.[0]?.text || "").slice(0, 2000);
                        if (resultText) postToFeed(session_id, dbUrl, `📄 Result: ${resultText}`);
                      }
                    } catch {}
                  }
                });
                proc.stderr.on("data", (chunk: Buffer) => {
                  const text = chunk.toString();
                  log("[stderr] " + text);
                  if (text.includes("Error") || text.includes("error") || text.includes("failed")) {
                    postToFeed(session_id, dbUrl, `⚠️ stderr: ${text.slice(0, 500)}`, "system", "console");
                  }
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

          const claudeArgs = [
            "-p", message,
            "--output-format", "stream-json",
            "--verbose",
            "--dangerously-skip-permissions",
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
            const proc = spawn("claude", claudeArgs, {
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
                      costUsd = (inputTokens / 1_000_000 * 3) + (outputTokens / 1_000_000 * 15);
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

        case "spawn_dev_lead": {
          const { session_id: sessionId } = args as any;
          const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://172.17.0.1:18789";
          const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";

          try {
            const resp = await fetch(`${gatewayUrl}/tools/invoke`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${gatewayToken}`,
              },
              body: JSON.stringify({
                tool: "sessions_spawn",
                args: { agentId: "dev-lead", task: await buildSpawnMessage(sessionId, process.env.OPS_DB_URL ?? ''), cwd: "/home/openclaw/agents/dev-lead" },
              }),
            });

            if (!resp.ok) {
              const text = await resp.text();
              return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Gateway ${resp.status}: ${text}` }) }] };
            }

            const parsed = await resp.json().catch(() => ({})) as any;
            const childSessionKey = parsed?.childSessionKey ?? parsed?.session_key ?? null;
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, session_id: sessionId, childSessionKey }) }] };
          } catch (fetchErr: any) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: fetchErr.message }) }] };
          }
        }

        case "create_session": {
          const {
            title,
            repo,
            container: sessionContainer = "dev-david",
            task_brief,
            slack_thread_url,
            jira_keys,
          } = args as any;

          const dbUrl = process.env.OPS_DB_URL;
          if (!dbUrl) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
          }

          const firstKey = jira_keys?.split(",")[0]?.trim().toLowerCase().replace(/-/g, "") ?? "";
          const ts = Date.now();
          const sessionId = firstKey
            ? `sess-${firstKey}-${ts}`
            : `sess-${randomUUID().slice(0, 8)}-${ts}`;
          const sessionUrl = `https://dev-sessions.ash.zennya.app/sessions/${sessionId}`;

          const jiraKeysArr = jira_keys
            ? `{${jira_keys.split(",").map((k: string) => k.trim()).join(",")}}`
            : null;

          try {
            await withDbClient(dbUrl, async (client) => {
              await client.query(
                `INSERT INTO sessions (session_id, project_id, container, repo, status, session_type, title, prompt_preview, jira_issue_keys, slack_thread_url, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'active', 'dev', $5, $6, $7::text[], $8, now(), now())`,
                [sessionId, repo, sessionContainer, repo, title, task_brief.slice(0, 500), jiraKeysArr, slack_thread_url || null]
              );

              const msgId = `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
              await client.query(
                `INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
                 VALUES ($1, $2, 'user', $3, 'task_brief', now())`,
                [msgId, sessionId, task_brief]
              );
            });

            try {
              const parsedJiraKeys = jira_keys
                ? jira_keys.split(",").map((k: string) => k.trim()).filter(Boolean)
                : [];
              const projRow = await withDbClient(dbUrl, async (client) => {
                const r = await client.query<{ confluence_root_id: string | null }>(
                  `SELECT confluence_root_id FROM projects WHERE project_id = $1`,
                  [repo]
                );
                return r.rows[0] ?? null;
              });
              const confluenceRootId = projRow?.confluence_root_id ?? null;
              await populateCacheForProject(dbUrl, parsedJiraKeys, confluenceRootId);
              console.log(`[create_session] cache warmed: jira=${parsedJiraKeys.join(",") || "none"} confluence=${confluenceRootId ?? "none"}`);
            } catch (cacheErr: any) {
              console.warn(`[create_session] cache warm failed (non-fatal): ${cacheErr.message}`);
            }

            const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://172.17.0.1:18789";
            const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
            let spawnOk = false;
            let spawnError = "";
            let childSessionKey: string | null = null;
            try {
              const resp = await fetch(`${gatewayUrl}/tools/invoke`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${gatewayToken}`,
                },
                body: JSON.stringify({
                  tool: "sessions_spawn",
                  args: { agentId: "dev-lead", task: await buildSpawnMessage(sessionId, dbUrl), cwd: "/home/openclaw/agents/dev-lead" },
                }),
              });
              if (!resp.ok) {
                const text = await resp.text();
                spawnError = `Gateway ${resp.status}: ${text}`;
              } else {
                const parsed = await resp.json().catch(() => ({})) as any;
                childSessionKey = parsed?.childSessionKey ?? parsed?.session_key ?? null;
                spawnOk = true;
              }
            } catch (fetchErr: any) {
              spawnError = fetchErr.message;
            }

            if (!spawnOk) {
              await withDbClient(dbUrl, async (client) => {
                await client.query(
                  `INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
                   VALUES (gen_random_uuid(), $1, 'dev_lead', $2, 'console', now())`,
                  [sessionId, `⚠️ Session created but spawn_dev_lead failed: ${spawnError}`]
                );
              }).catch(() => {});
              return { content: [{ type: "text", text: JSON.stringify({ ok: false, session_id: sessionId, session_url: sessionUrl, error: `spawn failed: ${spawnError}` }) }] };
            }

            return { content: [{ type: "text", text: JSON.stringify({ ok: true, session_id: sessionId, session_url: sessionUrl, childSessionKey }) }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: (err as Error).message }) }], isError: true };
          }
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
            deploy_cmd: inputDeployCmd,
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
          let deployCmd = inputDeployCmd || null;
          if (workingDir && (!buildCmd || !deployCmd)) {
            const hasSwarmYml = fs.existsSync(path.join(workingDir, 'swarm.yml'));
            const hasDockerfile = fs.existsSync(path.join(workingDir, 'Dockerfile'));
            const hasPkgJson = fs.existsSync(path.join(workingDir, 'package.json'));
            const hasRequirements = fs.existsSync(path.join(workingDir, 'requirements.txt'));
            const hasPyproject = fs.existsSync(path.join(workingDir, 'pyproject.toml'));

            if (!buildCmd || !deployCmd) {
              let detectedBuild: string | null = null;
              let detectedDeploy: string | null = null;
              if (hasSwarmYml) {
                detectedBuild = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
                detectedDeploy = `docker stack deploy -c ${workingDir}/swarm.yml ${projectId}`;
              } else if (hasDockerfile) {
                detectedBuild = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
                detectedDeploy = `docker service update --image ${projectId}:latest prod_${projectId} || docker service update --image ${projectId}:latest ${projectId}`;
              } else if (hasPkgJson) {
                let pkgJson: Record<string, unknown> = {};
                try { pkgJson = JSON.parse(fs.readFileSync(path.join(workingDir, 'package.json'), 'utf8')) as Record<string, unknown>; } catch {}
                const deps = (pkgJson?.dependencies ?? {}) as Record<string, unknown>;
                const devDeps = (pkgJson?.devDependencies ?? {}) as Record<string, unknown>;
                const isNext = Boolean(deps.next ?? devDeps.next);
                if (isNext) {
                  detectedBuild = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
                  detectedDeploy = `docker service update --image ${projectId}:latest prod_${projectId} || docker service update --image ${projectId}:latest ${projectId}`;
                } else {
                  detectedBuild = `cd ${workingDir} && npm install && npm run build`;
                  detectedDeploy = `pkill -f "node dist/index.js" 2>/dev/null || true; nohup node ${workingDir}/dist/index.js > /tmp/${projectId}.log 2>&1 &`;
                }
              } else if (hasRequirements || hasPyproject) {
                detectedBuild = `cd ${workingDir} && pip install -r ${hasRequirements ? 'requirements.txt' : '.'} -q`;
                detectedDeploy = `pkill -f "${workingDir}/main.py" 2>/dev/null || true; nohup python3 ${workingDir}/main.py > /tmp/${projectId}.log 2>&1 &`;
              }
              if (!buildCmd) buildCmd = detectedBuild;
              if (!deployCmd) deployCmd = detectedDeploy;
            }
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

        case "bootstrap_session": {
          const { user_request, user_id, project_id: bsProjectId, project_hint, display_name: bsDisplayName, description: bsDescription, slack_thread_url: bsSlackThreadUrl } = args as {
            user_request: string;
            user_id: string;
            project_id?: string;
            project_hint?: string;
            display_name?: string;
            description?: string;
            slack_thread_url?: string;
          };
          const result = await bootstrapSession({ user_request, user_id, project_id: bsProjectId, project_hint, display_name: bsDisplayName, description: bsDescription, slack_thread_url: bsSlackThreadUrl });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
