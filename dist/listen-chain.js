"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startListenChain = startListenChain;
const crypto_1 = require("crypto");
const pg_1 = require("pg");
const db_js_1 = require("./db.js");
const code_task_js_1 = require("./code-task.js");
const bootstrap_js_1 = require("./bootstrap.js");
const logger_js_1 = require("./logger.js");
let _reconnectMs = 1_000;
// Interval handle for periodic backfill2; cleared on pg client error to avoid timer accumulation.
let _backfill2Interval = null;
// Interval handle for listenClient keepalive SELECT 1; cleared on error to avoid accumulation.
let _keepaliveInterval = null;
// ── Backfill 2: find sessions with approval_response but no EXECUTION yet ──
// Extracted so it can be called at startup, after reconnect, and periodically.
async function runBackfill2(dbUrl) {
    const client = new pg_1.Client({ connectionString: dbUrl });
    try {
        await client.connect();
        const res = await client.query(`SELECT DISTINCT s.session_id
       FROM sessions s
       JOIN session_messages sm_ar ON sm_ar.session_id = s.session_id
         AND sm_ar.message_type = 'approval_response'
       WHERE s.status IN ('active', 'pending')
         AND s.session_type != 'interactive'
         AND s.active_task_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM session_messages sm2
           WHERE sm2.session_id = s.session_id
             AND sm2.message_type IN ('execution_update', 'checkpoint')
             AND sm2.role = 'coding_agent'
             AND sm2.created_at > sm_ar.created_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM session_messages sm3
           WHERE sm3.session_id = s.session_id
             AND sm3.message_type = 'execution_update'
             AND sm3.content LIKE '%spawn error%'
             AND sm3.created_at > now() - interval '10 minutes'
         )
       ORDER BY s.session_id`);
        if (res.rows.length > 0) {
            logger_js_1.logger.log(`[listen-chain] backfill2: ${res.rows.length} session(s) with unprocessed approval_response — spawning EXECUTION`);
            for (const row of res.rows) {
                try {
                    const { instruction, workingDir, resumeClaudeSessionId, model } = await (0, bootstrap_js_1.buildExecutionInstruction)(row.session_id, dbUrl);
                    (0, code_task_js_1.spawnCodeTask)({ instruction, workingDir, sessionId: row.session_id, dbUrl, resumeClaudeSessionId, model });
                    logger_js_1.logger.log(`[listen-chain] backfill2 EXECUTION spawned for ${row.session_id}`);
                    // Surface recovery in the session feed so it's visible in the UI
                    void (0, db_js_1.withDbClient)(dbUrl, async (c) => {
                        await c.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, metadata, created_at)
               VALUES (gen_random_uuid(), $1, 'system', $2, 'console', $3::jsonb, now())`, [row.session_id, '🔄 Recovery: EXECUTION re-triggered by backfill (missed approval_response notification)', JSON.stringify({ recovery_trigger: true })]);
                    }).catch((e) => logger_js_1.logger.warn(`[listen-chain] backfill2 console msg failed: ${e.message}`));
                }
                catch (e) {
                    logger_js_1.logger.error(`[listen-chain] backfill2 error for ${row.session_id}:`, e.message);
                }
            }
        }
    }
    catch (err) {
        logger_js_1.logger.error("[listen-chain] backfill2 error:", err.message);
    }
    finally {
        await client.end().catch(() => { });
    }
}
async function startListenChain() {
    const dbUrl = process.env.OPS_DB_URL;
    if (!dbUrl) {
        logger_js_1.logger.warn("[listen-chain] OPS_DB_URL not set — background LISTEN chain disabled");
        return;
    }
    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://172.17.0.1:18789";
    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
    const hooksToken = process.env.OPENCLAW_HOOKS_TOKEN ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
    const listenClient = new pg_1.Client({ connectionString: dbUrl });
    try {
        await listenClient.connect();
        await listenClient.query("LISTEN session_messages");
        await listenClient.query("LISTEN session_events");
        _reconnectMs = 1_000;
        logger_js_1.logger.log("[listen-chain] Postgres LISTEN session_messages + session_events started");
        // Keepalive: run SELECT 1 every 30s to detect silent connection drops after restart.
        // If it fails, emit 'error' to trigger the existing reconnect logic.
        _keepaliveInterval = setInterval(() => {
            listenClient.query("SELECT 1").catch((err) => {
                logger_js_1.logger.error("[listen-chain] keepalive SELECT 1 failed — triggering reconnect:", err.message);
                listenClient.emit("error", err);
            });
        }, 30_000);
        listenClient.on("notification", (msg) => {
            void (async () => {
                try {
                    // Log every notification received so we can trace missing events.
                    logger_js_1.logger.log(`[listen-chain] notification: channel=${msg.channel} len=${msg.payload?.length ?? 0}`);
                    if (!msg.payload)
                        return;
                    const payload = JSON.parse(msg.payload);
                    const sessionId = payload.session_id;
                    const messageType = payload.message_type;
                    if (!sessionId || !messageType)
                        return;
                    const isApprovalResponse = messageType === "approval_response";
                    const isChatMessage = messageType === "chat";
                    const isApprovalRequest = messageType === "approval_request";
                    const isCheckpoint = messageType === "checkpoint" && payload.role === "coding_agent";
                    if (!isApprovalResponse && !isChatMessage && !isApprovalRequest && !isCheckpoint)
                        return;
                    // ── Auto-approve countdown for low/medium approval_requests ──────
                    if (isApprovalRequest) {
                        void (async () => {
                            try {
                                const approvalClient = new pg_1.Client({ connectionString: dbUrl });
                                await approvalClient.connect();
                                const approvalRes = await approvalClient.query(`SELECT message_id, metadata, created_at FROM session_messages
                   WHERE session_id = $1 AND message_type = 'approval_request'
                   ORDER BY created_at DESC LIMIT 1`, [sessionId]);
                                await approvalClient.end().catch(() => { });
                                if (approvalRes.rows.length === 0)
                                    return;
                                const { message_id: approvalMsgId, metadata, created_at } = approvalRes.rows[0];
                                const complexity = metadata?.complexity ?? "medium";
                                if (complexity === "hard") {
                                    logger_js_1.logger.log(`[listen-chain] approval_request ${approvalMsgId} for ${sessionId} is hard — no auto-approve`);
                                    return;
                                }
                                const deadline = new Date(created_at).getTime() + 600_000;
                                const remaining = Math.max(0, deadline - Date.now());
                                logger_js_1.logger.log(`[listen-chain] approval_request ${approvalMsgId} for ${sessionId} (${complexity}) — auto-approve in ${Math.round(remaining / 1000)}s`);
                                setTimeout(async () => {
                                    try {
                                        const autoClient = new pg_1.Client({ connectionString: dbUrl });
                                        await autoClient.connect();
                                        // Advisory lock prevents duplicate auto-approvals when notification fires multiple times
                                        const lockRes = await autoClient.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [`auto-approve:${sessionId}:${approvalMsgId}`]);
                                        if (!lockRes.rows[0]?.locked) {
                                            await autoClient.end().catch(() => { });
                                            logger_js_1.logger.log(`[listen-chain] auto-approve duplicate suppressed for ${sessionId} (lock busy)`);
                                            return;
                                        }
                                        const existingRes = await autoClient.query(`SELECT 1 FROM session_messages
                       WHERE session_id = $1 AND message_type = 'approval_response'
                         AND created_at > (SELECT created_at FROM session_messages WHERE message_id = $2)
                       LIMIT 1`, [sessionId, approvalMsgId]);
                                        if (existingRes.rows.length > 0) {
                                            await autoClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`auto-approve:${sessionId}:${approvalMsgId}`]);
                                            await autoClient.end().catch(() => { });
                                            logger_js_1.logger.log(`[listen-chain] auto-approve skipped for ${sessionId} — already approved`);
                                            return;
                                        }
                                        const autoMsgId = `msg-${(0, crypto_1.randomUUID)()}`;
                                        const nowIso = new Date().toISOString();
                                        await autoClient.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, metadata, created_at)
                       VALUES ($1, $2, 'system', 'auto-approved', 'approval_response', $3::jsonb, NOW())`, [autoMsgId, sessionId, JSON.stringify({ auto_approved: true, complexity })]);
                                        const notifyPayload = JSON.stringify({
                                            id: autoMsgId, message_id: autoMsgId, session_id: sessionId,
                                            role: "system", message_type: "approval_response",
                                            content: "auto-approved", created_at: nowIso,
                                        });
                                        const safeId = sessionId.replace(/-/g, "_");
                                        await autoClient.query(`SELECT pg_notify($1, $2)`, [`session_messages_${safeId}`, notifyPayload]);
                                        await autoClient.query(`SELECT pg_notify($1, $2)`, [`session_messages`, notifyPayload]);
                                        await autoClient.query(`SELECT pg_notify($1, $2)`, [`session:${sessionId}`, notifyPayload]);
                                        await autoClient.end().catch(() => { });
                                        logger_js_1.logger.log(`[listen-chain] server auto-approved session ${sessionId} (msg ${autoMsgId})`);
                                    }
                                    catch (err) {
                                        logger_js_1.logger.error("[listen-chain] auto-approve error:", err.message);
                                    }
                                }, remaining);
                            }
                            catch (err) {
                                logger_js_1.logger.error("[listen-chain] approval_request handling error:", err.message);
                            }
                        })();
                        return;
                    }
                    // ── Skip interactive sessions ──────────────────────────────────
                    try {
                        const checkClient = new pg_1.Client({ connectionString: dbUrl });
                        await checkClient.connect();
                        const checkRes = await checkClient.query("SELECT session_type, status FROM sessions WHERE session_id = $1", [sessionId]);
                        await checkClient.end().catch(() => { });
                        if (checkRes.rows.length > 0) {
                            const session = checkRes.rows[0];
                            if (session.session_type === "interactive") {
                                logger_js_1.logger.log(`[listen-chain] skip for interactive session ${sessionId}`);
                                return;
                            }
                            if (isApprovalResponse && session.status !== "active" && session.status !== "pending") {
                                logger_js_1.logger.log(`[listen-chain] skip approval wake for non-active session ${sessionId} (${session.status})`);
                                return;
                            }
                            logger_js_1.logger.log(`[listen-chain] session check passed for ${sessionId} (type=${session.session_type} status=${session.status})`);
                        }
                    }
                    catch (e) {
                        logger_js_1.logger.warn(`[listen-chain] session check error for ${sessionId}:`, e.message);
                    }
                    // ── approval_response → EXECUTION code_task ───────────────────
                    if (isApprovalResponse) {
                        logger_js_1.logger.log(`[listen-chain] approval_response for ${sessionId} — spawning EXECUTION code task`);
                        const lockClient = new pg_1.Client({ connectionString: dbUrl });
                        try {
                            await lockClient.connect();
                            const lockRes = await lockClient.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [`exec:${sessionId}`]);
                            if (!lockRes.rows[0]?.locked) {
                                logger_js_1.logger.log(`[listen-chain] approval_response duplicate suppressed for ${sessionId} (execution lock busy)`);
                                await lockClient.end().catch(() => { });
                                return;
                            }
                            const { instruction, workingDir, resumeClaudeSessionId, model } = await (0, bootstrap_js_1.buildExecutionInstruction)(sessionId, dbUrl);
                            // Claim active_task_id in DB BEFORE spawning so backfill2 won't duplicate
                            const execTaskId = require("crypto").randomUUID();
                            const claimed = await lockClient.query(`UPDATE sessions SET active_task_id = $1, status = 'executing', updated_at = now()
                 WHERE session_id = $2 AND active_task_id IS NULL
                 RETURNING session_id`, [execTaskId, sessionId]);
                            if (claimed.rowCount === 0) {
                                logger_js_1.logger.log(`[listen-chain] EXECUTION already claimed for ${sessionId} — skipping`);
                                await lockClient.end().catch(() => { });
                                return;
                            }
                            (0, code_task_js_1.spawnCodeTask)({ instruction, workingDir, sessionId, dbUrl, resumeClaudeSessionId, model });
                            logger_js_1.logger.log(`[listen-chain] EXECUTION code task spawned for ${sessionId} (task_id=${execTaskId})`);
                        }
                        catch (e) {
                            logger_js_1.logger.error(`[listen-chain] EXECUTION spawn error for ${sessionId}:`, e.message);
                        }
                        finally {
                            try {
                                await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`exec:${sessionId}`]);
                            }
                            catch { }
                            await lockClient.end().catch(() => { });
                        }
                        return;
                    }
                    // ── checkpoint (coding_agent) → dev-lead close-out ────────────
                    if (isCheckpoint) {
                        logger_js_1.logger.log(`[listen-chain] checkpoint from coding_agent for ${sessionId} — triggering dev-lead close-out`);
                        const checkpointContent = payload.content ?? "(no checkpoint content)";
                        // Dedup: advisory lock so only one listener triggers close-out
                        const cpLockClient = new pg_1.Client({ connectionString: dbUrl });
                        try {
                            await cpLockClient.connect();
                            const cpLock = await cpLockClient.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [`closeout:${sessionId}`]);
                            if (!cpLock.rows[0]?.locked) {
                                logger_js_1.logger.log(`[listen-chain] checkpoint close-out duplicate suppressed for ${sessionId}`);
                                await cpLockClient.end().catch(() => { });
                                return;
                            }
                            await cpLockClient.end().catch(() => { });
                        }
                        catch (e) {
                            logger_js_1.logger.warn(`[listen-chain] checkpoint lock error for ${sessionId}: ${e.message}`);
                        }
                        try {
                            const task = await (0, bootstrap_js_1.buildCloseoutMessage)(sessionId, checkpointContent, dbUrl);
                            // Prefer sessions_send into the existing dev-lead session so it retains full
                            // conversation context with Ash. Fall back to sessions_spawn if no session exists yet.
                            const existingKey = await (0, db_js_1.withDbClient)(dbUrl, async (c) => {
                                const r = await c.query(`SELECT openclaw_session_key FROM sessions WHERE session_id = $1`, [sessionId]);
                                return r.rows[0]?.openclaw_session_key ?? null;
                            }).catch(() => null);
                            if (existingKey) {
                                // Post ash_callback message to session feed before sending (deduped)
                                const callbackPreview = checkpointContent.slice(0, 200);
                                const callbackContent = `code_task completed. Result: ${callbackPreview}`;
                                void (0, db_js_1.withDbClient)(dbUrl, async (c) => {
                                    const existing = await c.query(`SELECT message_id FROM session_messages
                     WHERE session_id = $1 AND role = 'system' AND message_type = 'ash_callback'
                       AND content = $2 AND created_at > now() - interval '30 seconds'
                     LIMIT 1`, [sessionId, callbackContent]);
                                    if (existing.rows.length === 0) {
                                        await c.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
                       VALUES (gen_random_uuid(), $1, 'system', $2, 'ash_callback', now())`, [sessionId, callbackContent]);
                                    }
                                }).catch((e) => logger_js_1.logger.warn(`[listen-chain] ash_callback dedupe write failed: ${e.message}`));
                                logger_js_1.logger.log(`[listen-chain] sessions_send to existing dev-lead session ${existingKey} for ${sessionId}`);
                                const sendResp = await fetch(`${gatewayUrl}/tools/invoke`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${gatewayToken}` },
                                    body: JSON.stringify({
                                        tool: "sessions_send",
                                        args: { sessionKey: existingKey, message: task, timeoutSeconds: 0 },
                                    }),
                                });
                                if (sendResp.ok) {
                                    logger_js_1.logger.log(`[listen-chain] sessions_send accepted for ${sessionId}`);
                                    return;
                                }
                                const text = await sendResp.text().catch(() => "");
                                logger_js_1.logger.warn(`[listen-chain] sessions_send failed (${sendResp.status} ${text.slice(0, 200)}) — falling back to sessions_spawn for ${sessionId}`);
                            }
                            // No existing session (or sessions_send failed) — spawn a fresh dev-lead close-out
                            const targetSessionKey = existingKey || `agent:dev-lead:dev-session:${sessionId}`;
                            const spawnResp = await fetch(`${gatewayUrl}/hooks/agent`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${hooksToken}` },
                                body: JSON.stringify({
                                    agentId: "dev-lead",
                                    message: task,
                                    cwd: "/home/openclaw/agents/dev-lead",
                                    sessionKey: targetSessionKey,
                                }),
                            });
                            if (spawnResp.ok) {
                                logger_js_1.logger.log(`[listen-chain] dev-lead close-out spawned for ${sessionId}, key=${targetSessionKey}`);
                                void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                    await client.query(`UPDATE sessions SET openclaw_session_key = $1, updated_at = now() WHERE session_id = $2`, [targetSessionKey, sessionId]);
                                }).catch((e) => logger_js_1.logger.warn(`[listen-chain] store openclaw_session_key failed: ${e.message}`));
                            }
                            else {
                                const text = await spawnResp.text().catch(() => "");
                                logger_js_1.logger.warn(`[listen-chain] dev-lead spawn failed for ${sessionId}: ${spawnResp.status} ${text.slice(0, 200)}`);
                            }
                        }
                        catch (e) {
                            logger_js_1.logger.error(`[listen-chain] close-out error for ${sessionId}:`, e.message);
                        }
                        return;
                    }
                    // ── chat → dev-lead (interactive help) ───────────────────────
                    if (isChatMessage) {
                        logger_js_1.logger.log(`[listen-chain] chat for ${sessionId} — spawning dev-lead`);
                        try {
                            // Resolve Ash's session key: prefer stored gateway_parent_key, fall back to env
                            const parentKeyRow = await (0, db_js_1.withDbClient)(dbUrl, async (c) => {
                                const r = await c.query(`SELECT gateway_parent_key FROM sessions WHERE session_id = $1`, [sessionId]);
                                return r.rows[0] ?? null;
                            }).catch(() => null);
                            const ashKey = parentKeyRow?.gateway_parent_key ?? undefined;
                            const targetSessionKey = `agent:dev-lead:dev-session:${sessionId}`;
                            const resp = await fetch(`${gatewayUrl}/hooks/agent`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${hooksToken}` },
                                body: JSON.stringify({
                                    agentId: "dev-lead",
                                    message: await (0, db_js_1.buildSpawnMessage)(sessionId, dbUrl, ashKey),
                                    cwd: "/home/openclaw/agents/dev-lead",
                                    sessionKey: targetSessionKey,
                                }),
                            });
                            if (resp.ok) {
                                logger_js_1.logger.log(`[listen-chain] dev-lead spawned for chat ${sessionId}, key=${targetSessionKey}`);
                                void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                    await client.query(`UPDATE sessions SET openclaw_session_key = $1, updated_at = now() WHERE session_id = $2`, [targetSessionKey, sessionId]);
                                }).catch((e) => logger_js_1.logger.warn(`[listen-chain] store openclaw_session_key failed: ${e.message}`));
                            }
                            else {
                                const text = await resp.text().catch(() => "");
                                logger_js_1.logger.warn(`[listen-chain] dev-lead chat spawn failed for ${sessionId}: ${resp.status} ${text.slice(0, 200)}`);
                            }
                        }
                        catch (e) {
                            logger_js_1.logger.error(`[listen-chain] chat spawn error for ${sessionId}:`, e.message);
                        }
                    }
                }
                catch (err) {
                    logger_js_1.logger.error("[listen-chain] notification handler error:", err.message);
                }
            })();
        });
        listenClient.on("error", (err) => {
            logger_js_1.logger.error("[listen-chain] Postgres LISTEN client error:", err.message);
            // Clear the keepalive interval — the new connection will set up a fresh one.
            if (_keepaliveInterval !== null) {
                clearInterval(_keepaliveInterval);
                _keepaliveInterval = null;
            }
            // Clear the periodic backfill2 interval — the new connection will set up a fresh one.
            if (_backfill2Interval !== null) {
                clearInterval(_backfill2Interval);
                _backfill2Interval = null;
            }
            const delay = _reconnectMs;
            _reconnectMs = Math.min(_reconnectMs * 2, 60_000);
            setTimeout(() => { void startListenChain(); }, delay);
        });
    }
    catch (err) {
        logger_js_1.logger.error("[listen-chain] failed to start LISTEN:", err.message);
        const delay = _reconnectMs;
        _reconnectMs = Math.min(_reconnectMs * 2, 60_000);
        setTimeout(() => { void startListenChain(); }, delay);
        return;
    }
    // Backfill 1: DISABLED — BOOTSTRAP is now spawned directly by bootstrapSession (Step 4b).
    // Keeping the query logic as a no-op comment for reference:
    // SELECT DISTINCT s.session_id FROM sessions s
    //   JOIN session_messages sm ON sm.session_id = s.session_id
    //   WHERE s.status = 'pending' AND sm.message_type = 'task_brief'
    //     AND sm.role = 'user' AND s.session_type != 'interactive'
    //     AND NOT EXISTS (SELECT 1 FROM session_messages sm2
    //       WHERE sm2.session_id = s.session_id AND sm2.role IN ('coding_agent', 'assistant'))
    // GAP-13 fix: Removed BOOTSTRAP spawn here to prevent dual orchestration race with bootstrapSession.
    // Backfill 2: run immediately on (re)connect, then every 60 seconds as a safety net.
    // This catches any approval_response notifications that were missed during a reconnect gap.
    void runBackfill2(dbUrl);
    _backfill2Interval = setInterval(() => { void runBackfill2(dbUrl); }, 60_000);
}
