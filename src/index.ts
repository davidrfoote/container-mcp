import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { withDbClient, notifySessionMessage, ensureMigrations } from "./db.js";
import { createMcpServer } from "./mcp-server.js";
import { startListenChain } from "./listen-chain.js";

// Re-export for external consumers
export { bootstrapSession } from "./bootstrap.js";

const app = express();
app.use(express.json());

// ─── SSE Transport (legacy MCP over HTTP) ──────────────────────────────────

const transports = new Map<string, SSEServerTransport>();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  const server = createMcpServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

// ─── Health ────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "container-mcp", version: "2.2.0" });
});

// ─── Session message HTTP endpoint (for claude CLI to post back) ──────────

app.post("/session/:sessionId/message", async (req, res) => {
  const { sessionId } = req.params;
  const { role = "coding_agent", content, message_type = "execution_update", metadata } = req.body || {};
  const dbUrl = process.env.OPS_DB_URL;
  if (!dbUrl || !sessionId || !content) {
    res.status(400).json({ ok: false, error: "Missing required fields: content" });
    return;
  }
  try {
    const row = await withDbClient(dbUrl, async (client) => {
      const metadataJson = metadata ? JSON.stringify(metadata) : null;
      const insertRes = await client.query<{ message_id: string; created_at: string }>(
        `INSERT INTO session_messages (message_id, session_id, role, content, message_type, metadata, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, now())
         RETURNING message_id, created_at`,
        [sessionId, role, content, message_type, metadataJson]
      );
      const inserted = insertRes.rows[0];
      if (inserted) {
        // Truncate content to stay well under PostgreSQL's 8000-byte pg_notify limit.
        // The listen-chain only needs session_id + message_type — full content is never read from the payload.
        const notifyPayload = JSON.stringify({
          id: inserted.message_id,
          message_id: inserted.message_id,
          session_id: sessionId,
          role,
          message_type,
          content: typeof content === "string" ? content.slice(0, 500) : "",
          created_at: inserted.created_at,
        });
        const safeId = sessionId.replace(/-/g, "_");
        const notifyErr = (e: unknown) => console.error("[pg_notify] error:", (e as Error).message);
        await client.query("SELECT pg_notify($1, $2)", [`session_messages_${safeId}`, notifyPayload]).catch(notifyErr);
        await client.query("SELECT pg_notify($1, $2)", [`session_messages`, notifyPayload]).catch(notifyErr);
        await client.query("SELECT pg_notify($1, $2)", [`session:${sessionId}`, notifyPayload]).catch(notifyErr);
      }
      return inserted;
    });
    res.json({ ok: true, message_id: row?.message_id });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[/session/:id/message] Error: ${msg}`);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "9000", 10);
const server = app.listen(PORT, () => {
  console.log(`container-mcp v2.2.0 running on port ${PORT}`);
  console.log(`  SSE:    http://localhost:${PORT}/sse`);
  console.log(`  Health: http://localhost:${PORT}/health`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[container-mcp] Port ${PORT} still in use - retrying in 5s`);
    setTimeout(() => { server.listen(PORT); }, 5000);
  } else {
    console.error(`[container-mcp] Server error: ${err.message}`);
  }
});

const dbUrl = process.env.OPS_DB_URL;
if (dbUrl) {
  ensureMigrations(dbUrl).catch((e) => console.warn("[migrations] Failed (non-fatal):", e.message));
}

void startListenChain();
