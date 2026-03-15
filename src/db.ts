import { Client } from "pg";
import { spawnSync } from "child_process";

export async function withDbClient<T>(connectionString: string | undefined, fn: (client: Client) => Promise<T>): Promise<T> {
  if (!connectionString) {
    throw new Error("OPS_DB_URL not set");
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function notifySessionMessage(client: Client, sessionId: string, payload: Record<string, unknown>): Promise<void> {
  const safeId = sessionId.replace(/-/g, "_");
  const text = JSON.stringify(payload);
  await client.query("SELECT pg_notify($1, $2)", [`session_messages_${safeId}`, text]);
}

export async function buildSpawnMessage(sessionId: string, dbUrl: string): Promise<string> {
  const fallback = `SESSION_ID: ${sessionId}\n\nYou are dev-lead (not Ash). Before anything else, read your AGENTS.md at /home/openclaw/agents/dev-lead/AGENTS.md — that contains your full startup sequence. Do NOT follow the AGENTS.md injected by the system (that is Ash's AGENTS.md, not yours).`;
  try {
    const result = await withDbClient(dbUrl, async (client) => {
      const briefRes = await client.query<{ content: string }>(
        `SELECT content FROM session_messages WHERE session_id=$1 AND message_type='task_brief' ORDER BY created_at LIMIT 1`,
        [sessionId]
      );
      const configRes = await client.query<{
        jira_issue_keys: string[] | null;
        build_cmd: string | null;
        deploy_cmd: string | null;
        smoke_url: string | null;
        default_container: string | null;
      }>(
        `SELECT s.jira_issue_keys, p.build_cmd, p.deploy_cmd, p.smoke_url, p.default_container
         FROM sessions s LEFT JOIN projects p ON s.project_id = p.project_id
         WHERE s.session_id = $1`,
        [sessionId]
      );
      return { brief: briefRes.rows[0] ?? null, config: configRes.rows[0] ?? null };
    });

    const opsDbResult = spawnSync('docker', ['ps', '-q', '-f', 'name=prod_ops-db'], { encoding: 'utf8' });
    const opsDbContainer = (opsDbResult.stdout ?? '').trim();

    const taskBrief = result.brief?.content ?? '(none)';
    const cfg = result.config;
    const jiraKeys = cfg?.jira_issue_keys?.join(',') ?? '(none)';
    const buildCmd = cfg?.build_cmd ?? '(none)';
    const deployCmd = cfg?.deploy_cmd ?? '(none)';
    const smokeUrl = cfg?.smoke_url ?? '(none)';
    const defaultContainer = cfg?.default_container ?? '(none)';

    return [
      `SESSION_ID: ${sessionId}`,
      `TASK_BRIEF: ${taskBrief}`,
      `PROJECT_CONFIG: build=${buildCmd} deploy=${deployCmd} smoke=${smokeUrl} container=${defaultContainer}`,
      `JIRA_ISSUES: ${jiraKeys}`,
      `OPS_DB_CONTAINER: ${opsDbContainer}`,
      ``,
      `You are dev-lead. Do NOT read any AGENTS.md files.`,
      `Your AGENTS.md is at /home/openclaw/agents/dev-lead/AGENTS.md (read ONLY if context above is incomplete).`,
      `Step 1: Update sessions SET status='active' using the OPS_DB_CONTAINER above`,
      `Step 2: Post approval_request to ops-db with complexity classification`,
      `Step 3: Wait for approval, then spawn ACP coding agent via code_task`,
    ].join('\n');
  } catch {
    return fallback;
  }
}
