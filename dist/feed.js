"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports._feedClients = void 0;
exports.postToFeed = postToFeed;
const pg_1 = require("pg");
const db_js_1 = require("./db.js");
exports._feedClients = new Map();
async function postToFeed(sessionId, dbUrl, content, role = "coding_agent", messageType = "execution_update") {
    if (!sessionId || !dbUrl)
        return;
    const key = `${sessionId}::${dbUrl}`;
    if (!exports._feedClients.has(key)) {
        const client = new pg_1.Client({ connectionString: dbUrl });
        await client.connect();
        exports._feedClients.set(key, { client, queue: Promise.resolve() });
    }
    const entry = exports._feedClients.get(key);
    entry.queue = entry.queue.then(async () => {
        try {
            const insertRes = await entry.client.query("INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING message_id, created_at", [sessionId, role, content, messageType]);
            const inserted = insertRes.rows[0];
            if (inserted) {
                try {
                    await (0, db_js_1.notifySessionMessage)(entry.client, sessionId, {
                        id: inserted.message_id,
                        message_id: inserted.message_id,
                        session_id: sessionId,
                        role,
                        message_type: messageType,
                        content,
                        created_at: inserted.created_at,
                    });
                }
                catch {
                    // non-fatal
                }
                try {
                    await entry.client.query("SELECT pg_notify($1, $2)", [
                        `session_feed:${sessionId}`,
                        JSON.stringify({
                            message_id: inserted.message_id,
                            message_type: messageType,
                            content,
                            role,
                            created_at: inserted.created_at,
                        }),
                    ]);
                }
                catch {
                    // non-fatal
                }
            }
        }
        catch (e) {
            console.error("postToFeed error:", e.message);
        }
    });
}
