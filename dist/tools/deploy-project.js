"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deployProject = deployProject;
const pg_1 = require("pg");
const code_task_js_1 = require("../code-task.js");
// --- DB helpers ---
async function withDeployClient(dbUrl, fn) {
    const client = new pg_1.Client({ connectionString: dbUrl });
    await client.connect();
    try {
        return await fn(client);
    }
    finally {
        await client.end().catch(() => { });
    }
}
async function lookupProject(dbUrl, projectId) {
    return withDeployClient(dbUrl, async (client) => {
        const result = await client.query('SELECT smoke_url, working_dir FROM projects WHERE project_id = $1', [projectId]);
        return result.rows[0] ?? null;
    });
}
async function postSessionMessage(dbUrl, sessionId, content, msgType = 'execution_update') {
    if (!sessionId)
        return;
    const msgId = `msg-${Date.now()}-deploy`;
    try {
        await withDeployClient(dbUrl, async (client) => {
            await client.query('INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at) VALUES ($1, $2, $3, $4, $5, now())', [msgId, sessionId, 'dev_lead', content, msgType]);
        });
    }
    catch (err) {
        console.error('[deploy_project] Failed to post session message:', err);
    }
}
function buildDeployInstruction(projectId, workingDir, smokeUrl, sessionId, port) {
    const smokeStep = smokeUrl
        ? `5. **Smoke test**: GET ${smokeUrl} — retry up to 12 times with 5s delay. Report HTTP status.`
        : `5. **Smoke test**: No smoke_url configured — skip.`;
    const checkpointCurl = `curl -s -X POST http://localhost:${port}/session/${sessionId}/message \\
  -H 'Content-Type: application/json' \\
  -d '{"content": "deploy_project(\\'${projectId}\\') complete — <summarize build/deploy/smoke result here>", "message_type": "checkpoint"}'`;
    return `# Deploy project: ${projectId}

Working directory: ${workingDir}
${smokeUrl ? `Smoke URL: ${smokeUrl}` : 'Smoke URL: none'}

## Steps

1. **Inspect topology**: Read these files if present (in order of precedence):
   - \`swarm.yml\` / \`docker-compose.yml\` → Docker Swarm / Compose deploy
   - \`Dockerfile\` → docker build + service update
   - \`deploy.sh\` / \`Makefile\` → run deploy target
   - \`package.json\` scripts → npm run deploy / npm run build
   Determine the correct build and deploy commands based on what exists.

2. **Build**: Run the appropriate build command. Fix any build errors before proceeding.

3. **Deploy**: Run the appropriate deploy command. Confirm the service is running.

4. **Verify**: Check process/container status to confirm successful deployment.

${smokeStep}

6. **Report**: Post a checkpoint message to the session feed:
\`\`\`bash
${checkpointCurl}
\`\`\`
Replace the summary with actual results (success/failure, smoke status, any errors).`;
}
// --- Main export ---
async function deployProject(projectId, sessionId) {
    const dbUrl = process.env.OPS_DB_URL;
    if (!dbUrl) {
        return { success: false, output: 'OPS_DB_URL not set', smoke_status: 'error' };
    }
    const port = process.env.PORT ?? '9000';
    try {
        const project = await lookupProject(dbUrl, projectId);
        const homeDir = process.env.AGENT_HOME_DIR ?? '/home/david';
        const workingDir = project?.working_dir ?? `${homeDir}/${projectId}`;
        const smokeUrl = project?.smoke_url ?? null;
        await postSessionMessage(dbUrl, sessionId ?? '', `🚀 Spawning CLI deploy agent for '${projectId}'...`, 'console');
        const instruction = buildDeployInstruction(projectId, workingDir, smokeUrl, sessionId ?? '', port);
        const taskId = (0, code_task_js_1.spawnCodeTask)({
            instruction,
            workingDir,
            sessionId,
            dbUrl,
            maxTurns: 20,
            budgetUsd: 2.0,
            timeoutSeconds: 600,
            model: 'sonnet',
        });
        return {
            success: true,
            output: `Deploy task ${taskId} spawned for project '${projectId}'`,
            smoke_status: 'pending',
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await postSessionMessage(dbUrl, sessionId ?? '', `❌ deploy_project error: ${msg}`, 'execution_log').catch(() => { });
        return { success: false, output: `Error: ${msg}`, smoke_status: 'error' };
    }
}
