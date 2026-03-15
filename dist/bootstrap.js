"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildBootstrapInstruction = buildBootstrapInstruction;
exports.buildExecutionInstruction = buildExecutionInstruction;
exports.buildCloseoutMessage = buildCloseoutMessage;
exports.resolveProject = resolveProject;
exports.ensureProject = ensureProject;
exports.bootstrapSession = bootstrapSession;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const db_js_1 = require("./db.js");
const code_task_js_1 = require("./code-task.js");
const jira_confluence_js_1 = require("./jira-confluence.js");
// ─── Instruction builders ──────────────────────────────────────────────────
async function buildBootstrapInstruction(sessionId, dbUrl) {
    const PORT = process.env.PORT ?? "9000";
    const data = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
        const sessionRes = await client.query(`SELECT s.project_id, s.jira_issue_keys, p.build_cmd, p.deploy_cmd, p.default_container, p.confluence_root_id
       FROM sessions s LEFT JOIN projects p ON p.project_id = s.project_id
       WHERE s.session_id = $1`, [sessionId]);
        const briefRes = await client.query(`SELECT content FROM session_messages WHERE session_id=$1 AND message_type='task_brief' ORDER BY created_at LIMIT 1`, [sessionId]);
        return { session: sessionRes.rows[0] ?? null, brief: briefRes.rows[0]?.content ?? "(no brief)" };
    });
    const projectId = data.session?.project_id ?? "unknown";
    const jiraKeys = data.session?.jira_issue_keys ?? [];
    const workingDir = `/home/david/${projectId}`;
    // Read cache summaries
    const cacheKeys = [
        ...(data.session?.confluence_root_id ? [`confluence:${data.session.confluence_root_id}`] : []),
        ...jiraKeys.map((k) => `jira:${k}`),
    ];
    let cacheSummary = "";
    for (const key of cacheKeys) {
        try {
            const row = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                const r = await client.query("SELECT summary FROM project_context_cache WHERE cache_key = $1", [key]);
                return r.rows[0] ?? null;
            });
            if (row?.summary)
                cacheSummary += `\n### ${key}\n${row.summary}\n`;
        }
        catch { }
    }
    const instruction = [
        `## BOOTSTRAP PASS — Session ${sessionId}`,
        ``,
        `You are a coding agent running a BOOTSTRAP planning pass. Your ONLY job is to read the project, understand the task, and post an implementation plan as an approval_request. Do NOT implement anything yet.`,
        ``,
        `### Task Brief`,
        data.brief,
        ``,
        `### Project`,
        `- project_id: ${projectId}`,
        `- repo: ${workingDir}`,
        `- jira: ${jiraKeys.join(", ") || "none"}`,
        `- build: ${data.session?.build_cmd ?? "none"}`,
        ``,
        cacheSummary ? `### Cached Context (Jira/Confluence)\n${cacheSummary}` : "",
        ``,
        `### Your Steps`,
        `1. Explore the codebase at ${workingDir} — read relevant files to understand the current state`,
        `2. Re-read the task brief and context above`,
        `3. Write a detailed implementation plan: which files to change, what logic to add/modify`,
        `4. Classify the complexity: trivial | low | medium | hard`,
        `5. Post the plan as an approval_request by running this exact curl command (replace placeholders):`,
        ``,
        `\`\`\`bash`,
        `PLAN="<your multi-line plan here — escape double-quotes with \\\\>"`,
        `COMPLEXITY="medium"  # trivial | low | medium | hard`,
        `curl -s -X POST http://localhost:${PORT}/session/${sessionId}/message \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d "{\\"role\\":\\"coding_agent\\",\\"message_type\\":\\"approval_request\\",\\"content\\":\\"$PLAN\\",\\"metadata\\":{\\"complexity\\":\\"$COMPLEXITY\\",\\"question\\":\\"Does this plan look good?\\",\\"options\\":[\\"approve\\",\\"reject\\"]}}"`,
        `\`\`\``,
        ``,
        `6. After the curl succeeds, EXIT immediately. Do NOT start coding — wait for approval.`,
    ].filter(Boolean).join("\n");
    // BOOTSTRAP is read-only: explore + plan only. Blocks Edit/Write/MultiEdit.
    const allowedTools = ["Read", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"];
    return { instruction, workingDir, allowedTools };
}
async function buildExecutionInstruction(sessionId, dbUrl) {
    const PORT = process.env.PORT ?? "9000";
    const data = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
        const sessionRes = await client.query(`SELECT s.project_id, s.jira_issue_keys, p.build_cmd, p.deploy_cmd, p.default_container, s.claude_session_id
       FROM sessions s LEFT JOIN projects p ON p.project_id = s.project_id
       WHERE s.session_id = $1`, [sessionId]);
        const planRes = await client.query(`SELECT content FROM session_messages WHERE session_id=$1 AND message_type='approval_request' AND role='coding_agent' ORDER BY created_at DESC LIMIT 1`, [sessionId]);
        const approvalRes = await client.query(`SELECT content FROM session_messages WHERE session_id=$1 AND message_type='approval_response' ORDER BY created_at DESC LIMIT 1`, [sessionId]);
        return {
            session: sessionRes.rows[0] ?? null,
            plan: planRes.rows[0]?.content ?? "(no plan found — implement based on the task brief)",
            approval: approvalRes.rows[0]?.content ?? "approved",
        };
    });
    const projectId = data.session?.project_id ?? "unknown";
    const jiraKeys = data.session?.jira_issue_keys ?? [];
    const primaryJira = jiraKeys[0] ?? "";
    const workingDir = `/home/david/${projectId}`;
    const resumeClaudeSessionId = data.session?.claude_session_id ?? undefined;
    const userMods = (data.approval !== "approved" && data.approval !== "auto-approved")
        ? `\n### User Modifications / Feedback\n${data.approval}\n`
        : "";
    const contextNote = resumeClaudeSessionId
        ? `\n> **Note:** This session resumes the BOOTSTRAP planning pass. You already explored the codebase — skip re-reading files you already know.\n`
        : "";
    const instruction = [
        `## EXECUTION PASS — Session ${sessionId}`,
        contextNote,
        `You are a coding agent. The plan below has been approved. Implement it fully.`,
        ``,
        `### Approved Plan`,
        data.plan,
        userMods,
        `### Project`,
        `- project_id: ${projectId}`,
        `- repo: ${workingDir}`,
        `- jira: ${jiraKeys.join(", ") || "none"}`,
        `- build: ${data.session?.build_cmd ?? "none"}`,
        `- deploy: ${data.session?.deploy_cmd ?? "none"}`,
        ``,
        `### Instructions`,
        `1. Create a feature branch: \`git checkout -b feature/${primaryJira || "dev"}-<short-description>\``,
        `2. Implement the approved plan`,
        `3. Commit with message: "${primaryJira ? primaryJira + ": " : ""}<description>"`,
        `4. When fully done, post a checkpoint via:`,
        ``,
        `\`\`\`bash`,
        `SUMMARY="<what was changed, which files, git SHA>"`,
        `curl -s -X POST http://localhost:${PORT}/session/${sessionId}/message \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d "{\\"role\\":\\"coding_agent\\",\\"message_type\\":\\"checkpoint\\",\\"content\\":\\"$SUMMARY\\"}"`,
        `\`\`\``,
        ``,
        `5. Exit after posting the checkpoint.`,
    ].filter(Boolean).join("\n");
    return { instruction, workingDir, resumeClaudeSessionId };
}
async function buildCloseoutMessage(sessionId, checkpointContent, dbUrl) {
    const fallback = `SESSION_ID: ${sessionId}\nROLE: close-out\nCHECKPOINT: ${checkpointContent}\n\nYou are dev-lead performing session close-out. Read AGENTS.md at /home/openclaw/agents/dev-lead/AGENTS.md.`;
    try {
        const config = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
            const r = await client.query(`SELECT s.project_id, s.jira_issue_keys, p.build_cmd, p.deploy_cmd, p.smoke_url, p.default_container
         FROM sessions s LEFT JOIN projects p ON p.project_id = s.project_id
         WHERE s.session_id = $1`, [sessionId]);
            return r.rows[0] ?? null;
        });
        if (!config)
            return fallback;
        return [
            `SESSION_ID: ${sessionId}`,
            `ROLE: close-out`,
            `CHECKPOINT: ${checkpointContent.slice(0, 1000)}`,
            `PROJECT: ${config.project_id}`,
            `JIRA_KEYS: ${config.jira_issue_keys?.join(",") ?? "none"}`,
            `BUILD: ${config.build_cmd ?? "none"}`,
            `DEPLOY: ${config.deploy_cmd ?? "none"}`,
            `SMOKE: ${config.smoke_url ?? "none"}`,
            ``,
            `You are dev-lead. The coding agent has finished. Your job is close-out only.`,
            `Read /home/openclaw/agents/dev-lead/AGENTS.md for the full procedure.`,
            `Steps: verify git SHA → merge to main → deploy → Jira to Done → WIP Confluence page → mark session completed → notify Ash.`,
        ].join("\n");
    }
    catch {
        return fallback;
    }
}
// ─── Project resolution ────────────────────────────────────────────────────
async function resolveProject(dbUrl, projectId, projectHint) {
    return (0, db_js_1.withDbClient)(dbUrl, async (client) => {
        const res = await client.query(`SELECT project_id, display_name, description FROM projects ORDER BY updated_at DESC`);
        const available_projects = res.rows;
        if (projectId) {
            const exact = available_projects.find((r) => r.project_id === projectId);
            if (exact)
                return { project_id: exact.project_id, available_projects };
        }
        if (projectHint) {
            const hint = projectHint.toLowerCase();
            const match = available_projects.find((r) => r.project_id.toLowerCase() === hint || (r.display_name ?? "").toLowerCase() === hint);
            if (match)
                return { project_id: match.project_id, available_projects };
        }
        return { project_id: null, available_projects };
    });
}
async function ensureProject(dbUrl, projectId, displayName, description) {
    await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
        let workingDir = null;
        for (const candidate of [`/home/david/${projectId}`, `/home/openclaw/apps/${projectId}`, `/opt/${projectId}`]) {
            if (fs.existsSync(candidate)) {
                workingDir = candidate;
                break;
            }
        }
        let buildCmd = null;
        let deployCmd = null;
        if (workingDir) {
            if (fs.existsSync(path.join(workingDir, "swarm.yml"))) {
                buildCmd = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
                deployCmd = `docker stack deploy -c ${workingDir}/swarm.yml ${projectId}`;
            }
            else if (fs.existsSync(path.join(workingDir, "Dockerfile"))) {
                buildCmd = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
                deployCmd = `docker service update --image ${projectId}:latest prod_${projectId} || docker service update --image ${projectId}:latest ${projectId}`;
            }
            else if (fs.existsSync(path.join(workingDir, "package.json"))) {
                buildCmd = `cd ${workingDir} && npm install && npm run build`;
                deployCmd = `pkill -f "node dist/index.js" 2>/dev/null || true; nohup node ${workingDir}/dist/index.js > /tmp/${projectId}.log 2>&1 &`;
            }
        }
        await client.query(`INSERT INTO projects (project_id, display_name, description, working_dir, default_container, build_cmd, deploy_cmd, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
       ON CONFLICT (project_id) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, projects.display_name),
         description = COALESCE(EXCLUDED.description, projects.description),
         updated_at = now()`, [projectId, displayName || null, description || null, workingDir, "dev-david", buildCmd, deployCmd]);
    });
}
// ─── bootstrapSession orchestrator ─────────────────────────────────────────
async function bootstrapSession(params) {
    const { user_request, user_id, project_id, project_hint, display_name, description } = params;
    const dbUrl = process.env.OPS_DB_URL;
    if (!dbUrl)
        return { ok: false, error: "OPS_DB_URL not set" };
    // Step 1: Resolve project
    let projectId = null;
    // Guard: reject project_id values that look like user IDs (e.g. Slack "U097Q46UX")
    if (project_id && /^[A-Z][A-Z0-9]{5,}$/.test(project_id)) {
        return { ok: false, error: `project_id "${project_id}" looks like a user ID, not a project identifier. Project IDs should be lowercase kebab-case (e.g. "my-api", "ash-dashboard").` };
    }
    try {
        const resolved = await resolveProject(dbUrl, project_id, project_hint);
        projectId = resolved.project_id;
        if (!projectId) {
            if (project_id) {
                console.log(`[bootstrapSession] Auto-creating project: ${project_id}`);
                await ensureProject(dbUrl, project_id, display_name, description);
                projectId = project_id;
            }
            else {
                console.log(`[bootstrapSession] No project matched, returning ${resolved.available_projects.length} projects for caller`);
                return {
                    ok: false,
                    needs_project: true,
                    available_projects: resolved.available_projects,
                    error: `Could not match a project. Please call again with an explicit project_id (pick from available_projects, or provide a new one to auto-create it).`,
                };
            }
        }
        console.log(`[bootstrapSession] resolved project: ${projectId}`);
    }
    catch (e) {
        return { ok: false, error: `Project lookup failed: ${e.message}` };
    }
    // Steps 2-3: Check for existing active session
    try {
        const existing = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
            const r = await client.query(`SELECT session_id FROM sessions WHERE user_id = $1 AND project_id = $2 AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [user_id, projectId]);
            return r.rows[0] ?? null;
        });
        if (existing) {
            const sessionUrl = `https://dev-sessions.ash.zennya.app/sessions/${existing.session_id}`;
            console.log(`[bootstrapSession] returning existing session ${existing.session_id}`);
            return { ok: true, session_id: existing.session_id, session_url: sessionUrl };
        }
    }
    catch (e) {
        return { ok: false, error: `Session check failed: ${e.message}` };
    }
    // Step 4: Fetch project config
    let projConfig = null;
    try {
        projConfig = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
            const r = await client.query(`SELECT display_name, description, default_container, jira_issue_keys, confluence_root_id FROM projects WHERE project_id = $1`, [projectId]);
            return r.rows[0] ?? null;
        });
    }
    catch (e) {
        return { ok: false, error: `Project config fetch failed: ${e.message}` };
    }
    if (!projConfig)
        return { ok: false, error: `Project not found: ${projectId}` };
    // Step 6: Search Jira for parent issue or create task issue
    const existingKeys = projConfig.jira_issue_keys ?? [];
    let jiraIssueKey = null;
    if (existingKeys.length > 0) {
        const projectKey = existingKeys[0].split("-")[0];
        const keywords = user_request.replace(/['"\\]/g, "").slice(0, 80);
        jiraIssueKey = await (0, jira_confluence_js_1.searchJiraForIssue)(projectKey, keywords);
        if (!jiraIssueKey) {
            jiraIssueKey = await (0, jira_confluence_js_1.createJiraTaskIssue)(projectKey, user_request.slice(0, 100), user_request);
        }
        if (jiraIssueKey)
            console.log(`[bootstrapSession] Jira issue: ${jiraIssueKey}`);
    }
    // Step 7: Compose task brief
    const taskBrief = [
        `Project: ${projConfig.display_name ?? projectId} (${projectId})`,
        `User request: ${user_request}`,
        projConfig.description ? `Context: ${projConfig.description}` : null,
        jiraIssueKey ? `Jira: ${jiraIssueKey}` : null,
        existingKeys.length > 0 ? `Parent issues: ${existingKeys.join(", ")}` : null,
    ].filter(Boolean).join("\n");
    // Step 8: Create session + spawn dev-lead
    const allJiraKeys = [...new Set([...(jiraIssueKey ? [jiraIssueKey] : []), ...existingKeys])];
    const firstKeyNorm = (allJiraKeys[0] ?? "").toLowerCase().replace(/-/g, "");
    const ts = Date.now();
    const sessionId = firstKeyNorm
        ? `sess-${firstKeyNorm}-${ts}`
        : `sess-${(0, crypto_1.randomUUID)().slice(0, 8)}-${ts}`;
    const sessionUrl = `https://dev-sessions.ash.zennya.app/sessions/${sessionId}`;
    const jiraKeysArr = allJiraKeys.length > 0 ? `{${allJiraKeys.join(",")}}` : null;
    try {
        await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
            await client.query(`INSERT INTO sessions (session_id, project_id, container, repo, status, title, prompt_preview, jira_issue_keys, user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7::text[], $8, now(), now())`, [sessionId, projectId, projConfig.default_container ?? "dev-david", projectId,
                user_request.slice(0, 100), taskBrief.slice(0, 500), jiraKeysArr, user_id]);
            const msgId = `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
            await client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
         VALUES ($1, $2, 'user', $3, 'task_brief', now())`, [msgId, sessionId, taskBrief]);
        });
    }
    catch (e) {
        return { ok: false, error: `Session creation failed: ${e.message}` };
    }
    // Step 5: Warm cache (non-fatal on failure)
    try {
        console.log(`[bootstrapSession] Starting cache warm for projectId=${projectId}, confluenceRootId=${projConfig.confluence_root_id}`);
        await (0, jira_confluence_js_1.populateCacheForProject)(dbUrl, projConfig.jira_issue_keys ?? [], projConfig.confluence_root_id ?? null);
        console.log(`[bootstrapSession] cache warmed successfully for ${projectId}`);
        await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
            await client.query('INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4)', [sessionId, 'dev_lead', '[CACHE-SUCCESS] Warmup complete for ' + projectId, 'console']);
        }).catch(() => { });
    }
    catch (e) {
        console.warn(`[bootstrapSession] cache warm failed (non-fatal): ${e.message}`);
        await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
            await client.query('INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4)', [sessionId, 'dev_lead', '[CACHE-FAILED] ' + e.message, 'console']);
        }).catch(() => { });
    }
    // Spawn BOOTSTRAP code task (non-fatal on failure)
    try {
        const { instruction, workingDir, allowedTools } = await buildBootstrapInstruction(sessionId, dbUrl);
        (0, code_task_js_1.spawnCodeTask)({ instruction, workingDir, sessionId, dbUrl, allowedTools });
        console.log(`[bootstrapSession] BOOTSTRAP code task spawned for session ${sessionId}`);
    }
    catch (e) {
        console.warn(`[bootstrapSession] BOOTSTRAP spawn error (non-fatal): ${e.message}`);
        await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
            await client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
         VALUES (gen_random_uuid(), $1, 'system', $2, 'console', now())`, [sessionId, `⚠️ Session created but BOOTSTRAP spawn failed: ${e.message}`]);
        }).catch(() => { });
    }
    console.log(`[bootstrapSession] created session ${sessionId} for user ${user_id} / project ${projectId}`);
    return { ok: true, session_id: sessionId, session_url: sessionUrl };
}
