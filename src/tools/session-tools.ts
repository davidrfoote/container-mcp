import { spawn } from "child_process";
import * as fs from "fs";
import { Client } from "pg";
import { withDbClient, notifySessionMessage, buildSpawnMessage } from "../db.js";
import { postToFeed, _feedClients } from "../feed.js";
import { bootstrapSession } from "../bootstrap.js";
import { populateCacheForProject } from "../jira-confluence.js";
import { transitionSession } from "../state-machine.js";
import type { ToolDefinition, McpToolResult } from "./git-tools.js";

const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "claude-sonnet-4-6";

function modelCostPerMillion(model?: string): { input: number; output: number } {
  if (!model) return { input: 3, output: 15 };
  const m = model.toLowerCase();
  if (m.includes("haiku")) return { input: 0.25, output: 1.25 };
  if (m.includes("opus")) return { input: 15, output: 75 };
  return { input: 3, output: 15 };
}

export const sessionToolDefinitions: ToolDefinition[] = [
  {
    name: "create_session",
    description: "Atomically create a dev session: INSERT into sessions table, INSERT task_brief into session_messages, and spawn dev-lead. Returns { ok, session_id, session_url }.",
    policy_class: "privileged",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the session" },
        repo: { type: "string", description: "Repository name (must match projects table project_id)" },
        container: { type: "string", description: "Dev container name (default: dev-david)" },
        task_brief: { type: "string", description: "Full task brief content to post as task_brief message" },
        slack_thread_url: { type: "string", description: "Slack thread URL for notifications (optional)" },
        jira_keys: { type: "string", description: "Comma-separated Jira issue keys (optional, e.g. ZI-18820)" },
        ash_session_key: { type: "string", description: "OpenClaw session key of the spawning Ash session (e.g. agent:main:openai:xxxx) for callback. Defaults to OPENCLAW_SESSION_KEY env var if not provided." },
      },
      required: ["title", "repo", "task_brief"],
    },
  },
  {
    name: "bootstrap_session",
    description: "Orchestrate a new dev session end-to-end. Resolves the project (exact match on project_id or project_hint), checks for existing active session, warms Jira/Confluence cache, creates/finds Jira issue, composes task brief, creates session record, and launches BOOTSTRAP planning pass via Claude Code CLI. If no project matches and no project_id is provided, returns needs_project=true with available_projects — the caller should then pick or create a project_id and call again.",
    policy_class: "privileged",
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
  {
    name: "spawn_dev_lead",
    description: "Spawn a dev-lead agent session via the OpenClaw gateway for a given ops-db session ID",
    policy_class: "privileged",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The ops-db session ID to spawn a dev-lead for" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "chat_session",
    description: "Run a direct interactive chat message via Claude Code CLI (claude --print), streaming output to ops-db and returning the claude session ID for context continuity",
    policy_class: "mutating",
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
    name: "listen_for_approval",
    description: "Wait on Postgres LISTEN/NOTIFY for a session approval_response",
    policy_class: "read_only",
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
    name: "post_message",
    description: "Post a message to a session feed (inserts into session_messages and emits pg_notify). Use this to post status_change, approval_request, checkpoint, or console messages from dev-lead.",
    policy_class: "mutating",
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
];

export async function handleSessionTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  switch (name) {
    case "create_session": {
      const {
        title,
        repo,
        container: sessionContainer = "dev-david",
        task_brief,
        slack_thread_url,
        jira_keys,
        ash_session_key,
      } = args as {
        title: string;
        repo: string;
        container?: string;
        task_brief: string;
        slack_thread_url?: string;
        jira_keys?: string;
        ash_session_key?: string;
      };

      const dbUrl = process.env.OPS_DB_URL;
      if (!dbUrl) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
      }

      const firstKey = jira_keys?.split(",")[0]?.trim().toLowerCase().replace(/-/g, "") ?? "";
      const ts = Date.now();
      const sessionId = firstKey
        ? `sess-${firstKey}-${ts}`
        : `sess-${crypto.randomUUID().slice(0, 8)}-${ts}`;
      const sessionUrl = `https://dev-sessions.ash.zennya.app/sessions/${sessionId}`;

      const jiraKeysArr = jira_keys
        ? `{${jira_keys.split(",").map((k: string) => k.trim()).join(",")}}`
        : null;

      try {
        const resolvedAshKey = ash_session_key || process.env.OPENCLAW_SESSION_KEY || null;
        await withDbClient(dbUrl, async (client) => {
          await client.query(
            `INSERT INTO sessions (session_id, project_id, container, repo, status, session_type, title, prompt_preview, jira_issue_keys, slack_thread_url, gateway_parent_key, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'pending', 'dev', $5, $6, $7::text[], $8, $9, now(), now())`,
            [sessionId, repo, sessionContainer, repo, title, task_brief.slice(0, 500), jiraKeysArr, slack_thread_url || null, resolvedAshKey]
          );

          const msgId = `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
          await client.query(
            `INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
             VALUES ($1, $2, 'user', $3, 'task_brief', now())`,
            [msgId, sessionId, task_brief]
          );
        });

        // Transition to 'active' via state machine
        const transitionResult = await transitionSession(dbUrl, sessionId, 'active');
        if (!transitionResult.ok) {
          console.warn(`[create_session] state transition to active failed: ${transitionResult.error}`);
        }

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
        } catch (cacheErr: unknown) {
          const message = cacheErr instanceof Error ? cacheErr.message : String(cacheErr);
          console.warn(`[create_session] cache warm failed (non-fatal): ${message}`);
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
              args: { agentId: "dev-lead", task: await buildSpawnMessage(sessionId, dbUrl, ash_session_key), cwd: "/home/openclaw/agents/dev-lead" },
            }),
          });
          if (!resp.ok) {
            const text = await resp.text();
            spawnError = `Gateway ${resp.status}: ${text}`;
          } else {
            const parsed = await resp.json().catch(() => ({})) as Record<string, unknown>;
            const details = (parsed?.result as Record<string, unknown>)?.details as Record<string, unknown> | undefined;
            childSessionKey = (details?.childSessionKey ?? (parsed?.details as Record<string, unknown>)?.childSessionKey ?? parsed?.childSessionKey ?? parsed?.session_key ?? null) as string | null;
            spawnOk = true;
          }
        } catch (fetchErr: unknown) {
          spawnError = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
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

        if (childSessionKey) {
          await withDbClient(dbUrl, async (client) => {
            await client.query(
              `UPDATE sessions SET openclaw_session_key = $1, updated_at = now() WHERE session_id = $2`,
              [childSessionKey, sessionId]
            );
          }).catch((e: unknown) => console.warn(`[create_session] store openclaw_session_key failed: ${e instanceof Error ? e.message : String(e)}`));
        }

        return { content: [{ type: "text", text: JSON.stringify({ ok: true, session_id: sessionId, session_url: sessionUrl, childSessionKey }) }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: (err as Error).message }) }], isError: true };
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

    case "spawn_dev_lead": {
      const { session_id: sessionId } = args as { session_id: string };
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

        const parsed = await resp.json().catch(() => ({})) as Record<string, unknown>;
        const childSessionKey = (parsed?.childSessionKey ?? parsed?.session_key ?? null) as string | null;
        if (childSessionKey) {
          const dbUrl = process.env.OPS_DB_URL;
          if (dbUrl) {
            void withDbClient(dbUrl, async (client) => {
              await client.query(
                `UPDATE sessions SET openclaw_session_key = $1, updated_at = now() WHERE session_id = $2`,
                [childSessionKey, sessionId]
              );
            }).catch((e: unknown) => console.warn(`[spawn_dev_lead] store openclaw_session_key failed: ${e instanceof Error ? e.message : String(e)}`));
          }
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, session_id: sessionId, childSessionKey }) }] };
      } catch (fetchErr: unknown) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) }) }] };
      }
    }

    case "chat_session": {
      const {
        message,
        session_id: chatSessionId,
        claude_session_id: existingClaudeSessionId,
        working_dir: chatWorkingDir = "/home/david/dev-session-app",
      } = args as {
        message: string;
        session_id?: string;
        claude_session_id?: string;
        working_dir?: string;
      };

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
        } catch (e: unknown) {
          console.warn("[chat_session] bootstrap error:", e instanceof Error ? e.message : String(e));
        }
      }

      const claudeArgs = [
        "-p", message,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model", DEFAULT_MODEL,
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
              const parsed = JSON.parse(line) as Record<string, unknown>;

              if (parsed.type === "assistant") {
                const content = (parsed.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> })?.content || [];
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
                          } catch (e: unknown) {
                            console.error("chat_session postToFeed error:", e instanceof Error ? e.message : String(e));
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
                  const usage = parsed.usage as { input_tokens?: number; output_tokens?: number };
                  const inputTokens = usage.input_tokens || 0;
                  const outputTokens = usage.output_tokens || 0;
                  tokensUsed = inputTokens + outputTokens;
                  const { input: inputCostPerM, output: outputCostPerM } = modelCostPerMillion();
                  costUsd = (inputTokens / 1_000_000 * inputCostPerM) + (outputTokens / 1_000_000 * outputCostPerM);
                }
                const resultText = ((parsed.result || parsed.output || "") as string);
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

        proc.on("close", (code: number | null) => {
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
                } catch (e: unknown) {
                  console.error("chat_session final chat error:", e instanceof Error ? e.message : String(e));
                }
              });
              if (resultClaudeSessionId) {
                entry.queue = entry.queue.then(async () => {
                  try {
                    await entry.client.query(
                      "UPDATE sessions SET claude_session_id = $1, updated_at = now() WHERE session_id = $2",
                      [resultClaudeSessionId, chatSessionId]
                    );
                  } catch (e: unknown) {
                    console.error("chat_session update claude_session_id error:", e instanceof Error ? e.message : String(e));
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
            }).catch((err: unknown) => console.error('[token-usage] Failed to update token usage:', err));
          }
          void code; // suppress unused warning
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

    case "listen_for_approval": {
      const { session_id, timeout_seconds = 1800 } = args as { session_id: string; timeout_seconds?: number };
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

    case "post_message": {
      const { session_id: pmSessionId, role: pmRole = "dev_lead", content: pmContent, message_type: pmMsgType = "status_change", metadata: pmMetadata } = args as {
        session_id: string;
        role?: string;
        content: string;
        message_type?: string;
        metadata?: Record<string, unknown>;
      };
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

    default:
      return { content: [{ type: "text", text: `Unknown session tool: ${name}` }], isError: true };
  }
}
