import { randomUUID } from "crypto";
import { Client } from "pg";
import { buildSpawnMessage } from "./db.js";
import { spawnCodeTask } from "./code-task.js";
import { buildBootstrapInstruction, buildExecutionInstruction, buildCloseoutMessage } from "./bootstrap.js";

export async function startListenChain(): Promise<void> {
  const dbUrl = process.env.OPS_DB_URL;
  if (!dbUrl) {
    console.warn("[listen-chain] OPS_DB_URL not set — background LISTEN chain disabled");
    return;
  }

  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://172.17.0.1:18789";
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";

  const listenClient = new Client({ connectionString: dbUrl });
  try {
    await listenClient.connect();
    await listenClient.query("LISTEN session_messages");
    await listenClient.query("LISTEN session_events");
    console.log("[listen-chain] Postgres LISTEN session_messages + session_events started");

    listenClient.on("notification", (msg) => {
      void (async () => {
        try {
          if (!msg.payload) return;
          const payload = JSON.parse(msg.payload) as {
            session_id?: string;
            message_type?: string;
            role?: string;
          };
          const sessionId = payload.session_id;
          const messageType = payload.message_type;
          if (!sessionId || !messageType) return;

          const isApprovalResponse = messageType === "approval_response";
          const isChatMessage = messageType === "chat";
          const isApprovalRequest = messageType === "approval_request";
          const isCheckpoint = messageType === "checkpoint" && payload.role === "coding_agent";

          if (!isApprovalResponse && !isChatMessage && !isApprovalRequest && !isCheckpoint) return;

          // ── Auto-approve countdown for low/medium approval_requests ──────
          if (isApprovalRequest) {
            void (async () => {
              try {
                const approvalClient = new Client({ connectionString: dbUrl });
                await approvalClient.connect();
                const approvalRes = await approvalClient.query<{
                  message_id: string;
                  metadata: Record<string, unknown> | null;
                  created_at: Date;
                }>(
                  `SELECT message_id, metadata, created_at FROM session_messages
                   WHERE session_id = $1 AND message_type = 'approval_request'
                   ORDER BY created_at DESC LIMIT 1`,
                  [sessionId]
                );
                await approvalClient.end().catch(() => {});

                if (approvalRes.rows.length === 0) return;
                const { message_id: approvalMsgId, metadata, created_at } = approvalRes.rows[0];
                const complexity = (metadata?.complexity as string | undefined) ?? "medium";

                if (complexity === "hard") {
                  console.log(`[listen-chain] approval_request ${approvalMsgId} for ${sessionId} is hard — no auto-approve`);
                  return;
                }

                const deadline = new Date(created_at).getTime() + 600_000;
                const remaining = Math.max(0, deadline - Date.now());
                console.log(`[listen-chain] approval_request ${approvalMsgId} for ${sessionId} (${complexity}) — auto-approve in ${Math.round(remaining / 1000)}s`);

                setTimeout(async () => {
                  try {
                    const autoClient = new Client({ connectionString: dbUrl });
                    await autoClient.connect();
                    const existingRes = await autoClient.query(
                      `SELECT 1 FROM session_messages
                       WHERE session_id = $1 AND message_type = 'approval_response'
                         AND created_at > (SELECT created_at FROM session_messages WHERE message_id = $2)
                       LIMIT 1`,
                      [sessionId, approvalMsgId]
                    );
                    if (existingRes.rows.length > 0) {
                      await autoClient.end().catch(() => {});
                      console.log(`[listen-chain] auto-approve skipped for ${sessionId} — already approved`);
                      return;
                    }
                    const autoMsgId = `msg-${randomUUID()}`;
                    const nowIso = new Date().toISOString();
                    await autoClient.query(
                      `INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
                       VALUES ($1, $2, 'system', 'auto-approved', 'approval_response', NOW())`,
                      [autoMsgId, sessionId]
                    );
                    const notifyPayload = JSON.stringify({
                      id: autoMsgId, message_id: autoMsgId, session_id: sessionId,
                      role: "system", message_type: "approval_response",
                      content: "auto-approved", created_at: nowIso,
                    });
                    const safeId = sessionId.replace(/-/g, "_");
                    await autoClient.query(`SELECT pg_notify($1, $2)`, [`session_messages_${safeId}`, notifyPayload]);
                    await autoClient.query(`SELECT pg_notify($1, $2)`, [`session_messages`, notifyPayload]);
                    await autoClient.query(`SELECT pg_notify($1, $2)`, [`session:${sessionId}`, notifyPayload]);
                    await autoClient.end().catch(() => {});
                    console.log(`[listen-chain] server auto-approved session ${sessionId} (msg ${autoMsgId})`);
                  } catch (err: any) {
                    console.error("[listen-chain] auto-approve error:", err.message);
                  }
                }, remaining);
              } catch (err: any) {
                console.error("[listen-chain] approval_request handling error:", err.message);
              }
            })();
            return;
          }

          // ── Skip interactive sessions ──────────────────────────────────
          try {
            const checkClient = new Client({ connectionString: dbUrl });
            await checkClient.connect();
            const checkRes = await checkClient.query<{ session_type: string; status: string }>(
              "SELECT session_type, status FROM sessions WHERE session_id = $1",
              [sessionId]
            );
            await checkClient.end().catch(() => {});
            if (checkRes.rows.length > 0) {
              const session = checkRes.rows[0];
              if (session.session_type === "interactive") {
                console.log(`[listen-chain] skip for interactive session ${sessionId}`);
                return;
              }
              if (isApprovalResponse && session.status !== "active" && session.status !== "pending") {
                console.log(`[listen-chain] skip approval wake for non-active session ${sessionId} (${session.status})`);
                return;
              }
            }
          } catch (e: any) {
            console.warn(`[listen-chain] session check error for ${sessionId}:`, e.message);
          }

          // ── approval_response → EXECUTION code_task ───────────────────
          if (isApprovalResponse) {
            console.log(`[listen-chain] approval_response for ${sessionId} — spawning EXECUTION code task`);
            try {
              const { instruction, workingDir, resumeClaudeSessionId } = await buildExecutionInstruction(sessionId, dbUrl);
              spawnCodeTask({ instruction, workingDir, sessionId, dbUrl, resumeClaudeSessionId });
              console.log(`[listen-chain] EXECUTION code task spawned for ${sessionId}`);
            } catch (e: any) {
              console.error(`[listen-chain] EXECUTION spawn error for ${sessionId}:`, e.message);
            }
            return;
          }

          // ── checkpoint (coding_agent) → dev-lead close-out ────────────
          if (isCheckpoint) {
            console.log(`[listen-chain] checkpoint from coding_agent for ${sessionId} — spawning dev-lead close-out`);
            const checkpointContent = (payload as any).content ?? "(no checkpoint content)";
            try {
              const task = await buildCloseoutMessage(sessionId, checkpointContent, dbUrl);
              const resp = await fetch(`${gatewayUrl}/tools/invoke`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${gatewayToken}` },
                body: JSON.stringify({
                  tool: "sessions_spawn",
                  args: { agentId: "dev-lead", task, cwd: "/home/openclaw/agents/dev-lead" },
                }),
              });
              if (resp.ok) {
                const parsed = await resp.json().catch(() => ({})) as any;
                console.log(`[listen-chain] dev-lead close-out spawned for ${sessionId}, key=${parsed?.childSessionKey ?? "n/a"}`);
              } else {
                const text = await resp.text().catch(() => "");
                console.warn(`[listen-chain] dev-lead spawn failed for ${sessionId}: ${resp.status} ${text.slice(0, 200)}`);
              }
            } catch (e: any) {
              console.error(`[listen-chain] close-out spawn error for ${sessionId}:`, e.message);
            }
            return;
          }

          // ── chat → dev-lead (interactive help) ───────────────────────
          if (isChatMessage) {
            console.log(`[listen-chain] chat for ${sessionId} — spawning dev-lead`);
            try {
              const resp = await fetch(`${gatewayUrl}/tools/invoke`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${gatewayToken}` },
                body: JSON.stringify({
                  tool: "sessions_spawn",
                  args: { agentId: "dev-lead", task: await buildSpawnMessage(sessionId, dbUrl), cwd: "/home/openclaw/agents/dev-lead" },
                }),
              });
              if (resp.ok) {
                const parsed = await resp.json().catch(() => ({})) as any;
                console.log(`[listen-chain] dev-lead spawned for chat ${sessionId}, key=${parsed?.childSessionKey ?? "n/a"}`);
              } else {
                const text = await resp.text().catch(() => "");
                console.warn(`[listen-chain] dev-lead chat spawn failed for ${sessionId}: ${resp.status} ${text.slice(0, 200)}`);
              }
            } catch (e: any) {
              console.error(`[listen-chain] chat spawn error for ${sessionId}:`, e.message);
            }
          }
        } catch (err: any) {
          console.error("[listen-chain] notification handler error:", err.message);
        }
      })();
    });

    listenClient.on("error", (err: Error) => {
      console.error("[listen-chain] Postgres LISTEN client error:", err.message);
      setTimeout(() => { void startListenChain(); }, 10_000);
    });
  } catch (err: any) {
    console.error("[listen-chain] failed to start LISTEN:", err.message);
    setTimeout(() => { void startListenChain(); }, 10_000);
    return;
  }

  // Backfill: find stuck pending sessions
  void (async () => {
    const backfillClient = new Client({ connectionString: dbUrl });
    try {
      await backfillClient.connect();
      const res = await backfillClient.query<{ session_id: string }>(
        `SELECT DISTINCT s.session_id
         FROM sessions s
         JOIN session_messages sm ON sm.session_id = s.session_id
         WHERE s.status = 'pending'
           AND sm.message_type = 'task_brief'
           AND sm.role = 'user'
           AND s.session_type != 'interactive'
           AND NOT EXISTS (
             SELECT 1 FROM session_messages sm2
             WHERE sm2.session_id = s.session_id
               AND sm2.role IN ('coding_agent', 'assistant')
           )
         ORDER BY s.session_id`
      );
      if (res.rows.length > 0) {
        console.log(`[listen-chain] backfill: ${res.rows.length} pending session(s) found — spawning BOOTSTRAP`);
        for (const row of res.rows) {
          try {
            const { instruction, workingDir, allowedTools } = await buildBootstrapInstruction(row.session_id, dbUrl);
            spawnCodeTask({ instruction, workingDir, sessionId: row.session_id, dbUrl, allowedTools });
            console.log(`[listen-chain] backfill BOOTSTRAP spawned for ${row.session_id}`);
          } catch (e: any) {
            console.error(`[listen-chain] backfill error for ${row.session_id}:`, e.message);
          }
        }
      }
    } catch (err: any) {
      console.error("[listen-chain] backfill error:", err.message);
    } finally {
      await backfillClient.end().catch(() => {});
    }
  })();
}
