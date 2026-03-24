import { withDbClient } from "../db.js";
import { writeCacheEntry } from "../jira-confluence.js";
import type { ToolDefinition, McpToolResult } from "./git-tools.js";

export const cacheToolDefinitions: ToolDefinition[] = [
  {
    name: "cache_read",
    description: "Read a cached project context summary from ops-db project_context_cache",
    policy_class: "read_only",
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
    policy_class: "mutating",
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
];

export async function handleCacheTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  switch (name) {
    case "cache_read": {
      const { cache_key } = args as { cache_key: string };
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
      const { cache_key, source_type, content_hash, source_updated = null, summary } = args as {
        cache_key: string;
        source_type: string;
        content_hash: string;
        source_updated?: string | null;
        summary: string;
      };
      const dbUrl = process.env.OPS_DB_URL;
      await writeCacheEntry(dbUrl!, cache_key, source_type, content_hash, source_updated, summary);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    }

    default:
      return { content: [{ type: "text", text: `Unknown cache tool: ${name}` }], isError: true };
  }
}
