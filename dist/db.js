"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withDbClient = withDbClient;
exports.notifySessionMessage = notifySessionMessage;
exports.ensureMigrations = ensureMigrations;
exports.buildSpawnMessage = buildSpawnMessage;
const pg_1 = require("pg");
const child_process_1 = require("child_process");
async function withDbClient(connectionString, fn) {
    if (!connectionString) {
        throw new Error("OPS_DB_URL not set");
    }
    const client = new pg_1.Client({ connectionString });
    await client.connect();
    try {
        return await fn(client);
    }
    finally {
        await client.end().catch(() => { });
    }
}
async function notifySessionMessage(client, sessionId, payload) {
    const safeId = sessionId.replace(/-/g, "_");
    // Truncate content to avoid exceeding PostgreSQL's 8000-byte pg_notify limit.
    // cli_context messages carry structured JSON — limit them more conservatively so
    // the rest of the envelope (keys + session_id + message_id etc.) fits comfortably.
    const truncated = { ...payload };
    if (typeof truncated.content === "string") {
        const isStructured = truncated.message_type === "cli_context";
        truncated.content = truncated.content.slice(0, isStructured ? 5000 : 2000);
    }
    const text = JSON.stringify(truncated);
    await client.query("SELECT pg_notify($1, $2)", [`session_messages_${safeId}`, text]);
}
async function ensureMigrations(dbUrl) {
    await withDbClient(dbUrl, async (client) => {
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS branch TEXT`);
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS worktree_path TEXT`);
        // Observability bridge columns (added for full pipeline tracing)
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS openclaw_session_key TEXT`);
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_task_id TEXT`);
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_started_at TIMESTAMPTZ`);
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS container_heartbeat_at TIMESTAMPTZ`);
        // CLI execution metadata (populated from stream-json result event)
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model TEXT`);
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS num_turns INT`);
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_duration_ms INT`);
        // Parent gateway session key — Ash's session that spawned this work (for callback routing)
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS gateway_parent_key TEXT`);
        // Observability overhaul columns
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cli_model VARCHAR(100)`);
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_hint VARCHAR(200)`);
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS interactive BOOLEAN DEFAULT false`);
        // Session-level Claude model selection
        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_model VARCHAR(100)`);
    });
}
async function buildSpawnMessage(sessionId, dbUrl, ashSessionKey) {
    const fallback = `SESSION_ID: ${sessionId}\n\nYou are dev-lead (not Ash). Before anything else, read your AGENTS.md at /home/openclaw/agents/dev-lead/AGENTS.md — that contains your full startup sequence. Do NOT follow the AGENTS.md injected by the system (that is Ash's AGENTS.md, not yours).`;
    try {
        const result = await withDbClient(dbUrl, async (client) => {
            const briefRes = await client.query(`SELECT content FROM session_messages WHERE session_id=$1 AND message_type='task_brief' ORDER BY created_at LIMIT 1`, [sessionId]);
            const configRes = await client.query(`SELECT s.jira_issue_keys, p.build_cmd, p.deploy_cmd, p.smoke_url, p.default_container, s.user_id, s.gateway_parent_key
         FROM sessions s LEFT JOIN projects p ON s.project_id = p.project_id
         WHERE s.session_id = $1`, [sessionId]);
            return { brief: briefRes.rows[0] ?? null, config: configRes.rows[0] ?? null };
        });
        const opsDbResult = (0, child_process_1.spawnSync)('docker', ['ps', '-q', '-f', 'name=prod_ops-db'], { encoding: 'utf8' });
        const opsDbContainer = (opsDbResult.stdout ?? '').trim();
        const taskBrief = result.brief?.content ?? '(none)';
        const cfg = result.config;
        const jiraKeys = cfg?.jira_issue_keys?.join(',') ?? '(none)';
        const buildCmd = cfg?.build_cmd ?? '(none)';
        const deployCmd = cfg?.deploy_cmd ?? '(none)';
        const smokeUrl = cfg?.smoke_url ?? '(none)';
        const defaultContainer = cfg?.default_container ?? '(none)';
        const resolvedAshSessionKey = ashSessionKey ?? cfg?.gateway_parent_key ?? process.env.OPENCLAW_SESSION_KEY ?? '';
        const userId = cfg?.user_id ?? '';
        return [
            `SESSION_ID: ${sessionId}`,
            `USER_ID: ${userId}`,
            `TASK_BRIEF: ${taskBrief}`,
            `PROJECT_CONFIG: build=${buildCmd} deploy=${deployCmd} smoke=${smokeUrl} container=${defaultContainer}`,
            `JIRA_ISSUES: ${jiraKeys}`,
            `OPS_DB_CONTAINER: ${opsDbContainer}`,
            `ASH_SESSION_KEY: ${resolvedAshSessionKey}`,
            ``,
            `You are dev-lead. Do NOT read any AGENTS.md files.`,
            `Your AGENTS.md is at /home/openclaw/agents/dev-lead/AGENTS.md (read ONLY if context above is incomplete).`,
            `Step 1: Update sessions SET status='active' using the OPS_DB_CONTAINER above`,
            `Step 2: Post approval_request to ops-db with complexity classification`,
            `Step 3: Wait for approval, then spawn ACP coding agent via code_task`,
        ].join('\n');
    }
    catch {
        return fallback;
    }
}
