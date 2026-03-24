import { withDbClient } from "../db.js";
import { nextAllowedActions } from "../state-machine.js";
import { gitToolDefinitions } from "./git-tools.js";
import { codeExecutionToolDefinitions } from "./code-execution-tools.js";
import { sessionToolDefinitions } from "./session-tools.js";
import { projectToolDefinitions } from "./project-tools.js";
import { cacheToolDefinitions } from "./cache-tools.js";
import type { ToolDefinition, McpToolResult } from "./git-tools.js";

export const introspectionToolDefinitions: ToolDefinition[] = [
  {
    name: "get_session_provenance",
    description: "Get full provenance and timeline for a session: status, next allowed transitions, branch, worktree, Jira keys, cost, turn count, and message timeline.",
    policy_class: "read_only",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The ops-db session ID" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_container_inventory",
    description: "Get a full inventory of this container: version, active sessions, worktrees, MCP servers, tool registry with policy classes, and health checks.",
    policy_class: "read_only",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

export async function handleIntrospectionTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  switch (name) {
    case "get_session_provenance": {
      const { session_id } = args as { session_id: string };
      const dbUrl = process.env.OPS_DB_URL;
      if (!dbUrl) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "OPS_DB_URL not set" }) }], isError: true };
      }

      try {
        const data = await withDbClient(dbUrl, async (client) => {
          const sessionRes = await client.query<{
            session_id: string;
            project_id: string;
            status: string;
            branch: string | null;
            worktree_path: string | null;
            jira_issue_keys: string[] | null;
            model: string | null;
            num_turns: number | null;
            cost_usd: string | null;
            created_at: string;
          }>(
            `SELECT s.session_id, s.project_id, s.status, s.branch, s.worktree_path,
                    s.jira_issue_keys, s.model, s.num_turns, s.cost_usd, s.created_at
             FROM sessions s
             WHERE s.session_id = $1`,
            [session_id]
          );

          if (sessionRes.rows.length === 0) {
            return null;
          }
          const session = sessionRes.rows[0];

          const messagesRes = await client.query<{
            message_type: string;
            role: string;
            created_at: string;
            content: string;
          }>(
            `SELECT message_type, role, created_at, content
             FROM session_messages
             WHERE session_id = $1
             ORDER BY created_at ASC
             LIMIT 100`,
            [session_id]
          );

          return { session, messages: messagesRes.rows };
        });

        if (!data) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Session not found: ${session_id}` }) }], isError: true };
        }

        const next_allowed_actions = await nextAllowedActions(dbUrl, session_id);

        const timeline = data.messages.map((m) => ({
          message_type: m.message_type,
          role: m.role,
          created_at: m.created_at,
          content_preview: m.content.slice(0, 200),
        }));

        return {
          content: [{ type: "text", text: JSON.stringify({
            session_id: data.session.session_id,
            project_id: data.session.project_id,
            status: data.session.status,
            next_allowed_actions,
            branch: data.session.branch,
            worktree_path: data.session.worktree_path,
            jira_issue_keys: data.session.jira_issue_keys,
            model: data.session.model,
            num_turns: data.session.num_turns,
            cost_usd: data.session.cost_usd ? parseFloat(data.session.cost_usd) : null,
            created_at: data.session.created_at,
            timeline,
          }) }],
        };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], isError: true };
      }
    }

    case "get_container_inventory": {
      const dbUrl = process.env.OPS_DB_URL;

      // Build tool registry from all domain modules
      const allToolDefs: ToolDefinition[] = [
        ...gitToolDefinitions,
        ...codeExecutionToolDefinitions,
        ...sessionToolDefinitions,
        ...projectToolDefinitions,
        ...cacheToolDefinitions,
        ...introspectionToolDefinitions,
      ];
      const tool_registry = allToolDefs.map((t) => ({ name: t.name, policy_class: t.policy_class }));

      // MCP servers from env
      const mcp_servers: string[] = [];
      if (process.env.GITNEXUS_SERVICE_URL) mcp_servers.push("gitnexus");

      let active_sessions: unknown[] = [];
      let worktrees: unknown[] = [];
      let db_health: "ok" | "error" = "error";

      if (dbUrl) {
        try {
          const result = await withDbClient(dbUrl, async (client) => {
            // SELECT 1 health check
            await client.query("SELECT 1");
            db_health = "ok";

            // Active sessions (have active_task_id set)
            const sessRes = await client.query<{
              session_id: string;
              project_id: string;
              status: string;
              active_task_id: string | null;
              branch: string | null;
            }>(
              `SELECT session_id, project_id, status, active_task_id, branch
               FROM sessions
               WHERE active_task_id IS NOT NULL
               ORDER BY updated_at DESC
               LIMIT 20`
            );

            // Worktrees from DB
            const wtRes = await client.query<{
              session_id: string;
              worktree_path: string;
              branch: string;
            }>(
              `SELECT session_id, worktree_path, branch
               FROM sessions
               WHERE worktree_path IS NOT NULL AND status NOT IN ('closed', 'failed')
               ORDER BY updated_at DESC
               LIMIT 50`
            );

            return { sessions: sessRes.rows, worktrees: wtRes.rows };
          });
          active_sessions = result.sessions;
          worktrees = result.worktrees;
        } catch {
          db_health = "error";
        }
      }

      // Gateway health check
      let gateway_health: "ok" | "error" = "error";
      const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://172.17.0.1:18789";
      try {
        const resp = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(3000) });
        gateway_health = resp.ok ? "ok" : "error";
      } catch {
        gateway_health = "error";
      }

      return {
        content: [{ type: "text", text: JSON.stringify({
          container_version: "2.3.0",
          active_sessions,
          worktrees,
          mcp_servers,
          tool_registry,
          health: { db: db_health, gateway: gateway_health },
        }) }],
      };
    }

    default:
      return { content: [{ type: "text", text: `Unknown introspection tool: ${name}` }], isError: true };
  }
}
