import { Client } from "pg";
import { notifySessionMessage } from "./db.js";

export const _feedClients = new Map<string, { client: InstanceType<typeof Client>; queue: Promise<void> }>();

export async function postToFeed(sessionId: string, dbUrl: string, content: string, role = "coding_agent", messageType = "execution_update"): Promise<void> {
  if (!sessionId || !dbUrl) return;
  const key = `${sessionId}::${dbUrl}`;
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
        [sessionId, role, content, messageType]
      );
      const inserted = insertRes.rows[0];
      if (inserted) {
        try {
          await notifySessionMessage(entry.client, sessionId, {
            id: inserted.message_id,
            message_id: inserted.message_id,
            session_id: sessionId,
            role,
            message_type: messageType,
            content,
            created_at: inserted.created_at,
          });
        } catch {
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
        } catch {
          // non-fatal
        }
      }
    } catch (e: any) {
      console.error("postToFeed error:", e.message);
    }
  });
}
