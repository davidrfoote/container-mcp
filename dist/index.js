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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapSession = bootstrapSession;
const express_1 = __importDefault(require("express"));
const crypto_1 = require("crypto");
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const pg_1 = require("pg");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const deploy_project_js_1 = require("./tools/deploy-project.js");
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
async function buildSpawnMessage(sessionId, dbUrl) {
    const fallback = `SESSION_ID: ${sessionId}\n\nYou are dev-lead (not Ash). Before anything else, read your AGENTS.md at /home/openclaw/agents/dev-lead/AGENTS.md — that contains your full startup sequence. Do NOT follow the AGENTS.md injected by the system (that is Ash's AGENTS.md, not yours).`;
    try {
        const result = await withDbClient(dbUrl, async (client) => {
            const briefRes = await client.query(`SELECT content FROM session_messages WHERE session_id=$1 AND message_type='task_brief' ORDER BY created_at LIMIT 1`, [sessionId]);
            const configRes = await client.query(`SELECT s.jira_issue_keys, p.build_cmd, p.deploy_cmd, p.smoke_url, p.default_container
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
    }
    catch {
        return fallback;
    }
}
async function notifySessionMessage(client, sessionId, payload) {
    const safeId = sessionId.replace(/-/g, "_");
    const text = JSON.stringify(payload);
    await client.query("SELECT pg_notify($1, $2)", [`session_messages_${safeId}`, text]);
}
// ─── Jira/Confluence fetch helpers ─────────────────────────────────────────
function logHttpError(msg) {
    const dbUrl = process.env.OPS_DB_URL;
    if (!dbUrl)
        return;
    withDbClient(dbUrl, (client) => client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`, ['httpget-debug', 'dev_lead', '[HTTP-ERROR] ' + msg, 'console'])).catch(() => { });
}
function httpGet(url, headers) {
    return new Promise((resolve, reject) => {
        if (!url || typeof url !== 'string' || url.trim() === '') {
            const err = `httpGet: url is null/undefined/empty (typeof=${typeof url})`;
            logHttpError(err);
            reject(new Error(err));
            return;
        }
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch (e) {
            const err = `URL constructor error for url=${url.slice(0, 150)}: ${e.message}`;
            logHttpError(err);
            reject(new Error(err));
            return;
        }
        const lib = parsed.protocol === "https:" ? https : http;
        const req = lib.get(url, { headers }, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                }
                else {
                    resolve(data);
                }
            });
        });
        req.on("error", reject);
        req.setTimeout(15000, () => { req.destroy(new Error("Request timed out")); });
    });
}
function httpPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === "https:" ? https : http;
        const bodyBuf = Buffer.from(body, "utf8");
        const req = lib.request(url, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json", "Content-Length": String(bodyBuf.length) },
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                }
                else {
                    resolve(data);
                }
            });
        });
        req.on("error", reject);
        req.setTimeout(15000, () => { req.destroy(new Error("Request timed out")); });
        req.write(bodyBuf);
        req.end();
    });
}
let _jiraAuthHeadersCache = null;
async function jiraAuthHeaders() {
    if (_jiraAuthHeadersCache)
        return _jiraAuthHeadersCache;
    try {
        const dbUrl = process.env.OPS_DB_URL;
        const token = await withDbClient(dbUrl, async (client) => {
            const res = await client.query(`SELECT value FROM secrets WHERE key = 'atlassian_token'`);
            return res.rows[0]?.value ?? null;
        });
        if (token) {
            const user = "david@zennya.com";
            const encoded = Buffer.from(`${user}:${token}`).toString("base64");
            _jiraAuthHeadersCache = { Authorization: `Basic ${encoded}`, Accept: "application/json" };
            return _jiraAuthHeadersCache;
        }
    }
    catch {
        // fall through to env var fallback
    }
    const user = process.env.JIRA_USERNAME ?? "";
    const token = process.env.JIRA_API_TOKEN ?? "";
    const encoded = Buffer.from(`${user}:${token}`).toString("base64");
    return { Authorization: `Basic ${encoded}`, Accept: "application/json" };
}
async function fetchJiraIssue(issueKey) {
    console.log(`[fetchJiraIssue] Fetching issueKey=${issueKey}`);
    const baseUrl = (process.env.JIRA_URL ?? "").replace(/\/$/, "");
    const url = `${baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}`;
    const body = await httpGet(url, await jiraAuthHeaders());
    const data = JSON.parse(body);
    return {
        updated: data.fields?.updated ?? "",
        description: data.fields?.description ?? "",
        summary: data.fields?.summary ?? "",
    };
}
async function logCacheWarning(dbUrl, message) {
    try {
        await withDbClient(dbUrl, async (client) => {
            await client.query('INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, now())', ['cache-debug-log', 'dev_lead', '[CACHE] ' + message, 'console']);
        });
    }
    catch (e) {
        console.error('[logCacheWarning] Failed:', e);
    }
}
async function fetchConfluencePage(pageId) {
    try {
        console.log(`[fetchConfluencePage] Fetching pageId=${pageId}`);
        const baseUrl = (process.env.JIRA_URL || "https://zennya.atlassian.net").replace(/\/$/, "");
        const url = `${baseUrl}/wiki/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,version`;
        console.log(`[fetchConfluencePage] baseUrl=${baseUrl}, url=${url}`);
        if (!url || !url.startsWith('https://')) {
            throw new Error(`Invalid Confluence URL constructed: ${url}`);
        }
        const headers = await jiraAuthHeaders();
        console.log(`[fetchConfluencePage] Auth headers obtained`);
        let body;
        try {
            body = await httpGet(url, headers);
        }
        catch (err) {
            console.log(`[fetchConfluencePage] ERROR during httpGet: ${err}`);
            throw err;
        }
        console.log(`[fetchConfluencePage] Received response, bodyLength=${body.length}`);
        const data = JSON.parse(body);
        const versionNumber = data.version?.number ?? 0;
        const bodyHtml = data.body?.storage?.value ?? "";
        console.log(`[fetchConfluencePage] Parsed version=${versionNumber}, bodyLength=${bodyHtml.length}`);
        return {
            versionNumber,
            versionWhen: data.version?.when ?? "",
            bodyHtml,
        };
    }
    catch (err) {
        const msg = 'fetchConfluencePage failed for pageId=' + pageId + ': ' + (err instanceof Error ? err.message : String(err));
        console.error(msg);
        throw err;
    }
}
function stripHtml(html) {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
async function writeCacheEntry(dbUrl, cacheKey, sourceType, contentHash, sourceUpdated, summary) {
    console.log(`[writeCacheEntry] Writing cache_key=${cacheKey}, source_type=${sourceType}`);
    try {
        await withDbClient(dbUrl, async (client) => {
            const existing = await client.query(`SELECT content_hash FROM project_context_cache WHERE cache_key = $1`, [cacheKey]);
            if (existing.rows.length > 0 && existing.rows[0].content_hash === contentHash) {
                console.log(`[writeCacheEntry] cache_key=${cacheKey} unchanged, skipping`);
                return;
            }
            const isUpdate = existing.rows.length > 0;
            await client.query(`INSERT INTO project_context_cache
           (cache_key, source_type, content_hash, source_updated, summary, cached_at, last_checked)
         VALUES ($1, $2, $3, $4, $5, now(), now())
         ON CONFLICT (cache_key) DO UPDATE SET
           source_type = EXCLUDED.source_type,
           content_hash = EXCLUDED.content_hash,
           source_updated = EXCLUDED.source_updated,
           summary = EXCLUDED.summary,
           cached_at = now(),
           last_checked = now()`, [cacheKey, sourceType, contentHash, sourceUpdated || null, summary]);
            console.log(`[writeCacheEntry] cache_key=${cacheKey} ${isUpdate ? "updated" : "inserted"} OK`);
        });
    }
    catch (err) {
        console.log(`[writeCacheEntry] DB ERROR for cache_key=${cacheKey}: ${err}`);
        throw err;
    }
}
async function populateCacheForProject(dbUrl, jiraKeys, confluenceRootId) {
    console.log(`[populateCacheForProject] Starting with confluenceRootId=${confluenceRootId}, jiraKeys=[${jiraKeys.join(", ")}]`);
    try {
        const tasks = [];
        for (const key of jiraKeys) {
            console.log(`[populateCacheForProject] Pushing task: fetchJiraIssue(${key})`);
            tasks.push((async () => {
                const issue = await fetchJiraIssue(key);
                const raw = issue.description || issue.summary || "";
                const summary = raw.slice(0, 2000);
                const contentHash = require('crypto').createHash('md5').update(issue.updated + ':' + summary).digest('hex');
                await writeCacheEntry(dbUrl, `jira:${key}`, "jira", contentHash, issue.updated, summary);
            })());
        }
        if (confluenceRootId && typeof confluenceRootId === 'string' && confluenceRootId.trim() !== '') {
            console.log(`[populateCacheForProject] Pushing task: fetchConfluencePage(${confluenceRootId})`);
            tasks.push((async () => {
                try {
                    console.log(`[populateCacheForProject] About to fetch Confluence page: ${confluenceRootId}`);
                    const page = await fetchConfluencePage(confluenceRootId);
                    const summary = stripHtml(page.bodyHtml).slice(0, 2000);
                    const contentHash = String(page.versionNumber || 'unknown');
                    await writeCacheEntry(dbUrl, `confluence:${confluenceRootId}`, "confluence", contentHash, page.versionWhen || null, summary);
                }
                catch (err) {
                    const msg = 'Confluence cache failed for pageId=' + confluenceRootId + ': ' + (err instanceof Error ? err.message : String(err));
                    await logCacheWarning(dbUrl, msg);
                    throw err;
                }
            })());
        }
        console.log(`[populateCacheForProject] Awaiting ${tasks.length} tasks`);
        await Promise.all(tasks);
        console.log(`[populateCacheForProject] All tasks complete`);
    }
    catch (err) {
        const msg = 'populateCacheForProject failed: ' + (err instanceof Error ? err.message : String(err));
        console.error(msg);
        await logCacheWarning(dbUrl, msg);
        throw err;
    }
}
// ─── Internal code task spawner ────────────────────────────────────────────
function spawnCodeTask(params) {
    const { instruction, workingDir, sessionId, dbUrl, maxTurns = 40, budgetUsd = 8.0, timeoutSeconds = 1200, model, effort, agents, allowedTools, resumeClaudeSessionId, taskRules, } = params;
    const taskId = (0, crypto_1.randomUUID)();
    taskLogs.set(taskId, []);
    const log = (line) => taskLogs.get(taskId).push(line);
    const debugLogPath = `/tmp/task-${taskId}-debug.log`;
    postToFeed(sessionId, dbUrl, `🚀 Starting code task (${taskId})${model ? ` [${model}]` : ""}${resumeClaudeSessionId ? " [resumed]" : ""}\n\n${instruction.slice(0, 400)}`);
    (async () => {
        try {
            // Build rules from base + project + task-specific
            const rulesFile = `/tmp/container-mcp-rules-${taskId}.md`;
            let rules = "";
            try {
                rules += fs.readFileSync("/home/david/.rules/base.md", "utf8") + "\n";
            }
            catch { }
            try {
                rules += fs.readFileSync(path.join(workingDir, ".rules/project.md"), "utf8") + "\n";
            }
            catch { }
            if (taskRules)
                rules += taskRules + "\n";
            fs.writeFileSync(rulesFile, rules);
            const claudeArgs = [
                "-p", instruction,
                "--output-format", "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--append-system-prompt-file", rulesFile,
                "--permission-mode", "acceptEdits",
                "--max-turns", String(maxTurns),
                "--max-budget-usd", String(budgetUsd),
                "--dangerously-skip-permissions",
                "--debug-file", debugLogPath,
            ];
            if (model)
                claudeArgs.push("--model", model);
            if (effort)
                claudeArgs.push("--effort", effort);
            if (agents)
                claudeArgs.push("--agents", agents);
            if (allowedTools && allowedTools.length > 0)
                claudeArgs.push("--allowed-tools", allowedTools.join(","));
            if (resumeClaudeSessionId)
                claudeArgs.push("--resume", resumeClaudeSessionId);
            const proc = (0, child_process_1.spawn)("claude", claudeArgs, {
                cwd: workingDir, env: process.env, stdio: ["ignore", "pipe", "pipe"],
            });
            const timer = setTimeout(() => { proc.kill("SIGTERM"); }, timeoutSeconds * 1000);
            proc.stdout.on("data", (chunk) => {
                const lines = chunk.toString().split("\n");
                for (const line of lines) {
                    if (!line.trim())
                        continue;
                    log(line);
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.type === "result") {
                            // Persist the claude session ID so EXECUTION pass can resume it
                            const claudeSessionId = parsed.session_id;
                            if (claudeSessionId && sessionId && dbUrl) {
                                void withDbClient(dbUrl, async (client) => {
                                    await client.query(`UPDATE sessions SET claude_session_id = $1, updated_at = now() WHERE session_id = $2`, [claudeSessionId, sessionId]).catch(() => { });
                                });
                            }
                            const output = (parsed.result || parsed.output || "");
                            postToFeed(sessionId, dbUrl, `✅ Task complete\n\n${output.slice(0, 4000)}`);
                            const usage = parsed.usage;
                            if (usage && sessionId && dbUrl) {
                                const inputTokens = usage.input_tokens || 0;
                                const outputTokens = usage.output_tokens || 0;
                                const costUsd = (inputTokens / 1_000_000 * 3) + (outputTokens / 1_000_000 * 15);
                                void withDbClient(dbUrl, async (client) => {
                                    await client.query(`UPDATE sessions SET token_usage = COALESCE(token_usage, 0) + $1, cost_usd = COALESCE(cost_usd, 0) + $2 WHERE session_id = $3`, [inputTokens + outputTokens, costUsd, sessionId]);
                                }).catch((err) => console.error("[token-usage] Failed:", err));
                            }
                        }
                        else if (parsed.type === "assistant") {
                            for (const block of (parsed.message?.content || [])) {
                                if (block.type === "tool_use") {
                                    postToFeed(sessionId, dbUrl, `🔧 \`${block.name}\` ${JSON.stringify(block.input || {}).slice(0, 500)}`);
                                }
                                else if (block.type === "text" && block.text?.trim() && !parsed.message?.usage) {
                                    const text = block.text.trim().slice(0, 1000);
                                    if (text.length > 20)
                                        postToFeed(sessionId, dbUrl, `💭 ${text}`);
                                }
                            }
                        }
                        else if (parsed.type === "tool_result") {
                            const resultText = (parsed.content?.[0]?.text || "").slice(0, 2000);
                            if (resultText)
                                postToFeed(sessionId, dbUrl, `📄 Result: ${resultText}`);
                        }
                    }
                    catch { }
                }
            });
            proc.stderr.on("data", (chunk) => {
                const text = chunk.toString();
                log("[stderr] " + text);
                // Surface non-trivial stderr to session feed (auth errors, crashes)
                if (text.includes("Error") || text.includes("error") || text.includes("failed")) {
                    postToFeed(sessionId, dbUrl, `⚠️ stderr: ${text.slice(0, 500)}`, "system", "console");
                }
            });
            proc.on("close", (code) => {
                clearTimeout(timer);
                try {
                    fs.unlinkSync(rulesFile);
                }
                catch { }
                postToFeed(sessionId, dbUrl, `✅ Process ${taskId} exited with code ${code}. Debug log: ${debugLogPath}`);
                console.log(`[spawnCodeTask] task ${taskId} done (code ${code}), debug log at ${debugLogPath}`);
            });
        }
        catch (err) {
            console.error(`[spawnCodeTask] Error: ${err.message}`);
            postToFeed(sessionId, dbUrl, `❌ Task ${taskId} failed to start: ${err.message}`);
        }
    })().catch((err) => console.error(`[spawnCodeTask] Unhandled rejection: ${err.message}`));
    return taskId;
}
async function buildBootstrapInstruction(sessionId, dbUrl) {
    const PORT = process.env.PORT ?? "9000";
    const data = await withDbClient(dbUrl, async (client) => {
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
            const row = await withDbClient(dbUrl, async (client) => {
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
    const data = await withDbClient(dbUrl, async (client) => {
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
        const config = await withDbClient(dbUrl, async (client) => {
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
// ─── bootstrapSession helpers ───────────────────────────────────────────────
async function matchProjectWithLLM(dbUrl, userRequest, projectHint) {
    return withDbClient(dbUrl, async (client) => {
        const res = await client.query(`SELECT project_id, display_name, description FROM projects`);
        if (res.rows.length === 0) {
            return { project_id: null, confidence: "none", reasoning: "No projects registered" };
        }
        const projectList = res.rows
            .map((r) => `- ${r.project_id}: ${r.display_name ?? "(no name)"} — ${r.description ?? "(no description)"}`)
            .join("\n");
        const prompt = `You are a project matcher. Given a user request and a list of registered projects, determine which project the request is about.

## Registered Projects
${projectList}

## User Request
"${userRequest}"${projectHint ? `\n\n## Hint\nThe user suggested this might be related to: "${projectHint}"` : ""}

## Instructions
Respond with EXACTLY one JSON object (no markdown fences, no extra text):
{"project_id": "<matched_id or null>", "confidence": "<high|low|none>", "reasoning": "<one sentence>"}

Rules:
- "high" = clearly about this project
- "low" = might be about this project but uncertain
- "none" = doesn't match any project, likely a new project
- If confidence is "none", set project_id to null`;
        try {
            const anthropic = new sdk_1.default();
            const response = await anthropic.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 200,
                messages: [{ role: "user", content: prompt }],
            });
            const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
            const parsed = JSON.parse(text);
            // Validate the returned project_id actually exists
            if (parsed.project_id && !res.rows.some((r) => r.project_id === parsed.project_id)) {
                console.warn(`[matchProjectWithLLM] LLM returned unknown project_id "${parsed.project_id}", treating as no match`);
                return { project_id: null, confidence: "none", reasoning: `LLM hallucinated project_id: ${parsed.reasoning}` };
            }
            return {
                project_id: parsed.project_id,
                confidence: parsed.confidence || "none",
                reasoning: parsed.reasoning || "",
            };
        }
        catch (e) {
            console.warn(`[matchProjectWithLLM] LLM call failed, falling back to word scoring: ${e.message}`);
            // Fallback: simple word scoring
            const words = userRequest.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
            const hint = projectHint?.toLowerCase();
            let bestMatch = null;
            let bestScore = 0;
            for (const row of res.rows) {
                const id = row.project_id.toLowerCase();
                const name = (row.display_name ?? "").toLowerCase();
                const desc = (row.description ?? "").toLowerCase();
                let score = 0;
                if (hint && (id.includes(hint) || name.includes(hint)))
                    score += 10;
                for (const word of words) {
                    if (id.includes(word))
                        score += 3;
                    if (name.includes(word))
                        score += 2;
                    if (desc.includes(word))
                        score += 1;
                }
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = row.project_id;
                }
            }
            return {
                project_id: bestScore > 0 ? bestMatch : null,
                confidence: bestScore >= 10 ? "high" : bestScore > 0 ? "low" : "none",
                reasoning: `Fallback word scoring (LLM unavailable): score=${bestScore}`,
            };
        }
    });
}
async function autoCreateProject(dbUrl, userRequest, projectHint) {
    // Use LLM to derive a sensible project_id and display_name from the request
    let projectId;
    let displayName;
    let description;
    try {
        const anthropic = new sdk_1.default();
        const response = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 200,
            messages: [{ role: "user", content: `Given this user request for a new software feature/project, derive a short project identifier, display name, and description.

User request: "${userRequest}"${projectHint ? `\nHint: "${projectHint}"` : ""}

Respond with EXACTLY one JSON object (no markdown fences):
{"project_id": "<lowercase-kebab-case, max 30 chars>", "display_name": "<Title Case, max 50 chars>", "description": "<one sentence describing the project>"}` }],
        });
        const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
        const parsed = JSON.parse(text);
        projectId = parsed.project_id.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
        displayName = parsed.display_name || projectId;
        description = parsed.description || userRequest.slice(0, 200);
    }
    catch (e) {
        // Fallback: derive from hint or first meaningful words
        console.warn(`[autoCreateProject] LLM failed, using fallback: ${e.message}`);
        projectId = (projectHint || userRequest)
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .trim()
            .split(/\s+/)
            .slice(0, 3)
            .join("-")
            .slice(0, 30);
        displayName = projectId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        description = userRequest.slice(0, 200);
    }
    // Insert into projects table with auto-detected settings
    await withDbClient(dbUrl, async (client) => {
        // Check candidate directories
        let workingDir = null;
        for (const candidate of [`/home/david/${projectId}`, `/home/openclaw/apps/${projectId}`, `/opt/${projectId}`]) {
            if (fs.existsSync(candidate)) {
                workingDir = candidate;
                break;
            }
        }
        // Auto-detect build/deploy if we found a directory
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
       ON CONFLICT (project_id) DO NOTHING`, [projectId, displayName, description, workingDir, "dev-david", buildCmd, deployCmd]);
    });
    return projectId;
}
async function searchJiraForIssue(projectKey, keywords) {
    const baseUrl = (process.env.JIRA_URL ?? "").replace(/\/$/, "");
    if (!baseUrl)
        return null;
    try {
        const safe = keywords.replace(/['"\\]/g, "").slice(0, 80);
        const jql = encodeURIComponent(`project = ${projectKey} AND summary ~ "${safe}" ORDER BY updated DESC`);
        const url = `${baseUrl}/rest/api/2/search?jql=${jql}&maxResults=1&fields=summary,key`;
        const body = await httpGet(url, await jiraAuthHeaders());
        const data = JSON.parse(body);
        return data.issues?.[0]?.key ?? null;
    }
    catch {
        return null;
    }
}
async function createJiraTaskIssue(projectKey, summary, description) {
    const baseUrl = (process.env.JIRA_URL ?? "").replace(/\/$/, "");
    if (!baseUrl)
        return null;
    try {
        const url = `${baseUrl}/rest/api/2/issue`;
        const payload = JSON.stringify({
            fields: {
                project: { key: projectKey },
                summary: summary.slice(0, 255),
                description,
                issuetype: { name: "Task" },
            },
        });
        const body = await httpPost(url, await jiraAuthHeaders(), payload);
        const data = JSON.parse(body);
        return data.key ?? null;
    }
    catch (e) {
        console.warn(`[bootstrapSession] Jira create failed: ${e.message}`);
        return null;
    }
}
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Task log storage
const taskLogs = new Map();
// ─── postToFeed helper ─────────────────────────────────────────────────────
const _feedClients = new Map();
async function postToFeed(sessionId, dbUrl, content, role = "coding_agent", messageType = "execution_update") {
    if (!sessionId || !dbUrl)
        return;
    const key = `${sessionId}::${dbUrl}`;
    if (!_feedClients.has(key)) {
        const client = new pg_1.Client({ connectionString: dbUrl });
        await client.connect();
        _feedClients.set(key, { client, queue: Promise.resolve() });
    }
    const entry = _feedClients.get(key);
    entry.queue = entry.queue.then(async () => {
        try {
            const insertRes = await entry.client.query("INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING message_id, created_at", [sessionId, role, content, messageType]);
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
// ─── bootstrapSession ───────────────────────────────────────────────────────
async function bootstrapSession(params) {
    const { user_request, user_id, project_hint } = params;
    const dbUrl = process.env.OPS_DB_URL;
    if (!dbUrl)
        return { ok: false, error: "OPS_DB_URL not set" };
    // Step 1: LLM-based project matching (with word-score fallback)
    let projectId = null;
    let matchResult = {
        project_id: null, confidence: "none", reasoning: "",
    };
    try {
        matchResult = await matchProjectWithLLM(dbUrl, user_request, project_hint);
        projectId = matchResult.project_id;
        console.log(`[bootstrapSession] project match: ${JSON.stringify(matchResult)}`);
    }
    catch (e) {
        return { ok: false, error: `Project lookup failed: ${e.message}` };
    }
    // Auto-create project if no match found
    if (!projectId) {
        console.log(`[bootstrapSession] No project matched, auto-creating from request`);
        try {
            projectId = await autoCreateProject(dbUrl, user_request, project_hint);
            console.log(`[bootstrapSession] Auto-created project: ${projectId}`);
        }
        catch (e) {
            return { ok: false, error: `No matching project and auto-create failed: ${e.message}` };
        }
    }
    // Steps 2-3: Check for existing active session
    try {
        const existing = await withDbClient(dbUrl, async (client) => {
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
        projConfig = await withDbClient(dbUrl, async (client) => {
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
        jiraIssueKey = await searchJiraForIssue(projectKey, keywords);
        if (!jiraIssueKey) {
            jiraIssueKey = await createJiraTaskIssue(projectKey, user_request.slice(0, 100), user_request);
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
        await withDbClient(dbUrl, async (client) => {
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
        await populateCacheForProject(dbUrl, projConfig.jira_issue_keys ?? [], projConfig.confluence_root_id ?? null);
        console.log(`[bootstrapSession] cache warmed successfully for ${projectId}`);
        await withDbClient(dbUrl, async (client) => {
            await client.query('INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4)', [sessionId, 'dev_lead', '[CACHE-SUCCESS] Warmup complete for ' + projectId, 'console']);
        }).catch(() => { });
    }
    catch (e) {
        console.warn(`[bootstrapSession] cache warm failed (non-fatal): ${e.message}`);
        await withDbClient(dbUrl, async (client) => {
            await client.query('INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4)', [sessionId, 'dev_lead', '[CACHE-FAILED] ' + e.message, 'console']);
        }).catch(() => { });
    }
    // Spawn BOOTSTRAP code task (non-fatal on failure)
    try {
        const { instruction, workingDir, allowedTools } = await buildBootstrapInstruction(sessionId, dbUrl);
        spawnCodeTask({ instruction, workingDir, sessionId, dbUrl, allowedTools });
        console.log(`[bootstrapSession] BOOTSTRAP code task spawned for session ${sessionId}`);
    }
    catch (e) {
        console.warn(`[bootstrapSession] BOOTSTRAP spawn error (non-fatal): ${e.message}`);
        await withDbClient(dbUrl, async (client) => {
            await client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
         VALUES (gen_random_uuid(), $1, 'system', $2, 'console', now())`, [sessionId, `⚠️ Session created but BOOTSTRAP spawn failed: ${e.message}`]);
        }).catch(() => { });
    }
    console.log(`[bootstrapSession] created session ${sessionId} for user ${user_id} / project ${projectId}`);
    return { ok: true, session_id: sessionId, session_url: sessionUrl };
}
// ─── MCP Server Factory ────────────────────────────────────────────────────
function createMcpServer() {
    const server = new index_js_1.Server({ name: "container-mcp", version: "2.2.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "code_task",
                description: "Run a coding task via Claude or Cline agent",
                inputSchema: {
                    type: "object",
                    properties: {
                        instruction: { type: "string", description: "Task instruction" },
                        working_dir: { type: "string", description: "Working directory" },
                        driver: {
                            type: "string",
                            enum: ["claude", "cline"],
                            default: "claude",
                            description: "Agent driver to use",
                        },
                        task_id: { type: "string", description: "Optional task ID (uuid generated if not provided)" },
                        max_turns: { type: "number", default: 30 },
                        budget_usd: { type: "number", default: 5.0 },
                        timeout_seconds: { type: "number", default: 900 },
                        task_rules: { type: "string", description: "Extra rules to append to system prompt" },
                        base_rules_path: { type: "string", default: "/home/david/.rules/base.md" },
                        project_rules_path: { type: "string", default: "/.rules/project.md" },
                        session_id: { type: "string", description: "ops-db session ID to post execution_update messages to" },
                        ops_db_url: { type: "string", description: "PostgreSQL connection URL (falls back to OPS_DB_URL env)" },
                        model: {
                            type: "string",
                            description: "Model override (e.g. 'haiku', 'sonnet', 'opus', or full model ID). Defaults to account default.",
                        },
                        effort: {
                            type: "string",
                            enum: ["low", "medium", "high", "max"],
                            description: "Effort level (controls reasoning depth). Default: medium.",
                        },
                        agents: {
                            type: "string",
                            description: "JSON object defining custom sub-agents available to this task. E.g. '{\"reviewer\":{\"description\":\"Reviews code\",\"prompt\":\"You are a code reviewer\"}}'",
                        },
                        allowed_tools: {
                            type: "array",
                            items: { type: "string" },
                            description: "Whitelist of tools the CLI may use. E.g. [\"Read\",\"Glob\",\"Grep\",\"Bash\"]. Omit for all tools.",
                        },
                        resume_claude_session_id: {
                            type: "string",
                            description: "Resume a previous claude CLI session by session ID for context continuity across passes.",
                        },
                        add_dirs: {
                            type: "array",
                            items: { type: "string" },
                            description: "Additional directories to allow tool access to (passed as --add-dir).",
                        },
                    },
                    required: ["instruction", "working_dir"],
                },
            },
            {
                name: "get_task_log",
                description: "Get buffered log lines for a task",
                inputSchema: {
                    type: "object",
                    properties: {
                        task_id: { type: "string" },
                    },
                    required: ["task_id"],
                },
            },
            {
                name: "run_tests",
                description: "Run tests in a working directory",
                inputSchema: {
                    type: "object",
                    properties: {
                        working_dir: { type: "string" },
                        test_cmd: { type: "string", description: "Test command (falls back to .project.json or TEST_CMD)" },
                    },
                    required: ["working_dir"],
                },
            },
            {
                name: "run_build",
                description: "Run build in a working directory",
                inputSchema: {
                    type: "object",
                    properties: {
                        working_dir: { type: "string" },
                        build_cmd: { type: "string", description: "Build command (falls back to .project.json or BUILD_CMD)" },
                    },
                    required: ["working_dir"],
                },
            },
            {
                name: "get_diff",
                description: "Get git diff for a working directory",
                inputSchema: {
                    type: "object",
                    properties: {
                        working_dir: { type: "string" },
                        from_ref: { type: "string", default: "HEAD" },
                        to_ref: { type: "string", description: "Target ref (default: working tree)" },
                    },
                    required: ["working_dir"],
                },
            },
            {
                name: "get_repo_state",
                description: "Get current git repo state",
                inputSchema: {
                    type: "object",
                    properties: {
                        working_dir: { type: "string" },
                    },
                    required: ["working_dir"],
                },
            },
            {
                name: "cache_read",
                description: "Read a cached project context summary from ops-db project_context_cache",
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
            {
                name: "listen_for_approval",
                description: "Wait on Postgres LISTEN/NOTIFY for a session approval_response",
                inputSchema: {
                    type: "object",
                    properties: {
                        session_id: { type: "string" },
                        timeout_seconds: { type: "number", default: 1800 },
                    },
                    required: ["session_id"],
                },
            },
            {
                name: "git_status",
                description: "Get git status for a repo (branch, staged, unstaged, untracked files)",
                inputSchema: {
                    type: "object",
                    properties: {
                        repo: { type: "string", description: "Short repo name, resolved to /home/david/<repo>" },
                    },
                    required: ["repo"],
                },
            },
            {
                name: "git_checkout",
                description: "Switch or create a git branch",
                inputSchema: {
                    type: "object",
                    properties: {
                        repo: { type: "string", description: "Short repo name" },
                        branch: { type: "string", description: "Branch name to checkout" },
                        create: { type: "boolean", default: false, description: "Create branch if true (-b flag)" },
                    },
                    required: ["repo", "branch"],
                },
            },
            {
                name: "git_add",
                description: "Stage files for commit",
                inputSchema: {
                    type: "object",
                    properties: {
                        repo: { type: "string", description: "Short repo name" },
                        files: { type: "array", items: { type: "string" }, description: "Files to stage, use ['.'] for all" },
                    },
                    required: ["repo", "files"],
                },
            },
            {
                name: "git_commit",
                description: "Commit staged files. Always uses GIT_AUTHOR_NAME='Dev-Lead Agent' GIT_AUTHOR_EMAIL='dev-lead@zennya.app'",
                inputSchema: {
                    type: "object",
                    properties: {
                        repo: { type: "string", description: "Short repo name" },
                        message: { type: "string", description: "Commit message" },
                    },
                    required: ["repo", "message"],
                },
            },
            {
                name: "git_push",
                description: "Push commits to origin",
                inputSchema: {
                    type: "object",
                    properties: {
                        repo: { type: "string", description: "Short repo name" },
                        branch: { type: "string", description: "Branch to push (default: current branch)" },
                        force: { type: "boolean", default: false, description: "Force push with --force" },
                    },
                    required: ["repo"],
                },
            },
            {
                name: "git_merge",
                description: "Merge a branch into the current branch",
                inputSchema: {
                    type: "object",
                    properties: {
                        repo: { type: "string", description: "Short repo name" },
                        branch: { type: "string", description: "Branch to merge in" },
                        no_ff: { type: "boolean", default: true, description: "Use --no-ff flag (default true)" },
                    },
                    required: ["repo", "branch"],
                },
            },
            {
                name: "git_pull",
                description: "Pull and rebase from origin",
                inputSchema: {
                    type: "object",
                    properties: {
                        repo: { type: "string", description: "Short repo name" },
                    },
                    required: ["repo"],
                },
            },
            {
                name: "create_git_worktree",
                description: "Create an isolated git worktree for parallel work. Returns the worktree path and branch name.",
                inputSchema: {
                    type: "object",
                    properties: {
                        repo: { type: "string", description: "Short repo name (resolved to /home/david/<repo>)" },
                        base_branch: { type: "string", default: "main", description: "Branch to base the worktree on (default: main)" },
                        worktree_id: { type: "string", description: "Optional identifier for the worktree (used in path and branch name). Auto-generated if omitted." },
                    },
                    required: ["repo"],
                },
            },
            {
                name: "delete_git_worktree",
                description: "Remove a git worktree and optionally delete its branch.",
                inputSchema: {
                    type: "object",
                    properties: {
                        worktree_path: { type: "string", description: "Absolute path to the worktree to remove" },
                        delete_branch: { type: "boolean", default: false, description: "Also delete the worktree's branch after removal" },
                    },
                    required: ["worktree_path"],
                },
            },
            {
                name: "list_git_worktrees",
                description: "List all active git worktrees for a repo.",
                inputSchema: {
                    type: "object",
                    properties: {
                        repo: { type: "string", description: "Short repo name (resolved to /home/david/<repo>)" },
                    },
                    required: ["repo"],
                },
            },
            {
                name: "spawn_dev_lead",
                description: "Spawn a dev-lead agent session via the OpenClaw gateway for a given ops-db session ID",
                inputSchema: {
                    type: "object",
                    properties: {
                        session_id: { type: "string", description: "The ops-db session ID to spawn a dev-lead for" },
                    },
                    required: ["session_id"],
                },
            },
            {
                name: "create_session",
                description: "Atomically create a dev session: INSERT into sessions table, INSERT task_brief into session_messages, and spawn dev-lead. Returns { ok, session_id, session_url }.",
                inputSchema: {
                    type: "object",
                    properties: {
                        title: { type: "string", description: "Short title for the session" },
                        repo: { type: "string", description: "Repository name (must match projects table project_id)" },
                        container: { type: "string", description: "Dev container name (default: dev-david)" },
                        task_brief: { type: "string", description: "Full task brief content to post as task_brief message" },
                        slack_thread_url: { type: "string", description: "Slack thread URL for notifications (optional)" },
                        jira_keys: { type: "string", description: "Comma-separated Jira issue keys (optional, e.g. ZI-18820)" },
                    },
                    required: ["title", "repo", "task_brief"],
                },
            },
            {
                name: "warm_cache_for_repos",
                description: "Pre-populate project_context_cache for one or more repos by fetching their Jira issues and Confluence root page from the projects table",
                inputSchema: {
                    type: "object",
                    properties: {
                        repos: {
                            type: "array",
                            items: { type: "string" },
                            description: "List of project_id values from the projects table (e.g. ['dev-session-app', 'container-mcp', 'ash-dashboard']). Defaults to all three if omitted.",
                        },
                    },
                    required: [],
                },
            },
            {
                name: "chat_session",
                description: "Run a direct interactive chat message via Claude Code CLI (claude --print), streaming output to ops-db and returning the claude session ID for context continuity",
                inputSchema: {
                    type: "object",
                    properties: {
                        message: { type: "string", description: "User message to send to Claude" },
                        session_id: { type: "string", description: "ops-db session ID (for logging to session feed)" },
                        claude_session_id: { type: "string", description: "Existing Claude session ID to resume (omit or null for new session)" },
                        working_dir: { type: "string", description: "Working directory (defaults to /home/david/dev-session-app)" },
                    },
                    required: ["message"],
                },
            },
            {
                name: "deploy_project",
                description: "Deploy a project by ID. Reads build_cmd/deploy_cmd/smoke_url from projects table. Auto-detects deploy type for new projects. Runs build, deploy, smoke test with 12 retries. Posts result to session feed.",
                inputSchema: {
                    type: "object",
                    properties: {
                        project_id: {
                            type: "string",
                            description: "Project ID (matches projects table project_id)",
                        },
                        session_id: {
                            type: "string",
                            description: "Optional session ID to post progress messages to",
                        },
                    },
                    required: ["project_id"],
                },
            },
            {
                name: "post_message",
                description: "Post a message to a session feed (inserts into session_messages and emits pg_notify). Use this to post status_change, approval_request, checkpoint, or console messages from dev-lead.",
                inputSchema: {
                    type: "object",
                    properties: {
                        session_id: { type: "string", description: "The ops-db session ID" },
                        role: {
                            type: "string",
                            enum: ["coding_agent", "dev_lead", "system"],
                            default: "dev_lead",
                            description: "Message role",
                        },
                        content: { type: "string", description: "Message content" },
                        message_type: {
                            type: "string",
                            default: "status_change",
                            description: "Message type: status_change | approval_request | checkpoint | execution_update | console | execution_log",
                        },
                        metadata: { type: "object", description: "Optional metadata (e.g. {complexity, question, options} for approval_request)" },
                    },
                    required: ["session_id", "content"],
                },
            },
            {
                name: "create_project",
                description: "Register a new project in the projects table (or update an existing one). Sets display name, description, build/deploy commands, working directory, default container, Jira keys, Confluence root, and smoke URL. Auto-detects build/deploy commands from the filesystem if not provided.",
                inputSchema: {
                    type: "object",
                    properties: {
                        project_id: {
                            type: "string",
                            description: "Unique project identifier (e.g. 'my-api', 'ash-dashboard'). Used as PK in projects table.",
                        },
                        display_name: {
                            type: "string",
                            description: "Human-readable project name (e.g. 'Ash Dashboard')",
                        },
                        description: {
                            type: "string",
                            description: "Brief project description/context",
                        },
                        working_dir: {
                            type: "string",
                            description: "Absolute path to the project directory (e.g. /home/david/my-api). Auto-detected if omitted.",
                        },
                        default_container: {
                            type: "string",
                            description: "Default dev container name (e.g. 'dev-david')",
                        },
                        build_cmd: {
                            type: "string",
                            description: "Build command. Auto-detected from filesystem if omitted.",
                        },
                        deploy_cmd: {
                            type: "string",
                            description: "Deploy command. Auto-detected from filesystem if omitted.",
                        },
                        smoke_url: {
                            type: "string",
                            description: "Health-check URL to verify deployment (e.g. https://app.example.com/health)",
                        },
                        jira_issue_keys: {
                            type: "string",
                            description: "Comma-separated parent Jira issue keys (e.g. 'ZI-18820,ZI-18821')",
                        },
                        confluence_root_id: {
                            type: "string",
                            description: "Confluence page ID for project documentation root",
                        },
                    },
                    required: ["project_id"],
                },
            },
            {
                name: "bootstrap_session",
                description: "Orchestrate a new dev session end-to-end: fuzzy-match project from request text, check for existing active session, warm Jira/Confluence cache, create/find Jira issue, compose task brief, create session record, and launch BOOTSTRAP planning pass via Claude Code CLI.",
                inputSchema: {
                    type: "object",
                    properties: {
                        user_request: {
                            type: "string",
                            description: "Natural-language description of what the user wants to do",
                        },
                        user_id: {
                            type: "string",
                            description: "User identifier (e.g. Slack user ID or email)",
                        },
                        project_hint: {
                            type: "string",
                            description: "Optional project_id hint to bias fuzzy matching",
                        },
                    },
                    required: ["user_request", "user_id"],
                },
            },
        ],
    }));
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        try {
            switch (name) {
                case "code_task": {
                    const { instruction, working_dir, driver = "claude", task_id, max_turns = 30, budget_usd = 5.0, timeout_seconds = 900, task_rules, base_rules_path = "/home/david/.rules/base.md", project_rules_path = "/.rules/project.md", session_id, ops_db_url, model, effort, agents, allowed_tools, resume_claude_session_id, add_dirs, } = args;
                    const dbUrl = ops_db_url || process.env.OPS_DB_URL;
                    const taskId = task_id || (0, crypto_1.randomUUID)();
                    taskLogs.set(taskId, []);
                    const log = (line) => taskLogs.get(taskId).push(line);
                    const debugLogPath = `/tmp/task-${taskId}-debug.log`;
                    postToFeed(session_id, dbUrl, `🚀 Starting \`code_task\` (driver: ${driver}, task_id: ${taskId}${model ? `, model: ${model}` : ""}${resume_claude_session_id ? ", resumed" : ""})\n\nInstruction: ${instruction.slice(0, 400)}`);
                    // Compose rules
                    let rules = "";
                    try {
                        rules += fs.readFileSync(base_rules_path, "utf8") + "\n";
                    }
                    catch { }
                    try {
                        rules += fs.readFileSync(path.join(working_dir, project_rules_path), "utf8") + "\n";
                    }
                    catch { }
                    if (task_rules)
                        rules += task_rules + "\n";
                    if (driver === "claude") {
                        const rulesFile = `/tmp/container-mcp-rules-${taskId}.md`;
                        fs.writeFileSync(rulesFile, rules);
                        // Spawn ASYNC - return immediately
                        (async () => {
                            try {
                                const memUsage = process.memoryUsage();
                                console.log(`[code_task] Starting task ${taskId}. Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
                                const claudeArgs = [
                                    "-p", instruction,
                                    "--output-format", "stream-json",
                                    "--verbose",
                                    "--include-partial-messages",
                                    "--append-system-prompt-file", rulesFile,
                                    "--permission-mode", "acceptEdits",
                                    "--max-turns", String(max_turns),
                                    "--max-budget-usd", String(budget_usd),
                                    "--session-id", taskId,
                                    "--dangerously-skip-permissions",
                                    "--debug-file", debugLogPath,
                                ];
                                if (model)
                                    claudeArgs.push("--model", model);
                                if (effort)
                                    claudeArgs.push("--effort", effort);
                                if (agents)
                                    claudeArgs.push("--agents", typeof agents === "string" ? agents : JSON.stringify(agents));
                                if (allowed_tools && Array.isArray(allowed_tools) && allowed_tools.length > 0) {
                                    claudeArgs.push("--allowed-tools", allowed_tools.join(","));
                                }
                                if (resume_claude_session_id)
                                    claudeArgs.push("--resume", resume_claude_session_id);
                                if (add_dirs && Array.isArray(add_dirs)) {
                                    for (const dir of add_dirs)
                                        claudeArgs.push("--add-dir", dir);
                                }
                                const proc = (0, child_process_1.spawn)("claude", claudeArgs, {
                                    cwd: working_dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
                                });
                                let output = "";
                                const timer = setTimeout(() => { proc.kill("SIGTERM"); }, timeout_seconds * 1000);
                                proc.stdout.on("data", (chunk) => {
                                    const lines = chunk.toString().split("\n");
                                    for (const line of lines) {
                                        if (!line.trim())
                                            continue;
                                        log(line);
                                        try {
                                            const parsed = JSON.parse(line);
                                            if (parsed.type === "result") {
                                                // Save claude session ID for potential resume
                                                const claudeSessionId = parsed.session_id;
                                                if (claudeSessionId && session_id && dbUrl) {
                                                    void withDbClient(dbUrl, async (client) => {
                                                        await client.query(`UPDATE sessions SET claude_session_id = $1, updated_at = now() WHERE session_id = $2`, [claudeSessionId, session_id]);
                                                    }).catch(() => { });
                                                }
                                                output = parsed.result || parsed.output || JSON.stringify(parsed);
                                                postToFeed(session_id, dbUrl, `✅ Task complete\n\n${output.slice(0, 4000)}`);
                                                const usage = parsed.usage;
                                                if (usage && (usage.input_tokens || usage.output_tokens) && session_id && dbUrl) {
                                                    const inputTokens = usage.input_tokens || 0;
                                                    const outputTokens = usage.output_tokens || 0;
                                                    const totalTokens = inputTokens + outputTokens;
                                                    const costUsd = (inputTokens / 1_000_000 * 3) + (outputTokens / 1_000_000 * 15);
                                                    void withDbClient(dbUrl, async (client) => {
                                                        await client.query(`UPDATE sessions SET token_usage = COALESCE(token_usage, 0) + $1, cost_usd = COALESCE(cost_usd, 0) + $2 WHERE session_id = $3`, [totalTokens, costUsd, session_id]);
                                                    }).catch((err) => console.error('[token-usage] Failed to update token usage:', err));
                                                }
                                            }
                                            else if (parsed.type === "assistant") {
                                                const content = parsed.message?.content || [];
                                                for (const block of content) {
                                                    if (block.type === "tool_use") {
                                                        const toolInput = JSON.stringify(block.input || {}).slice(0, 500);
                                                        postToFeed(session_id, dbUrl, `🔧 \`${block.name}\` ${toolInput}`);
                                                    }
                                                    else if (block.type === "text" && block.text?.trim() && !parsed.message?.usage) {
                                                        const text = block.text.trim().slice(0, 1000);
                                                        if (text.length > 20)
                                                            postToFeed(session_id, dbUrl, `💭 ${text}`);
                                                    }
                                                }
                                            }
                                            else if (parsed.type === "tool_result") {
                                                const resultText = (parsed.content?.[0]?.text || "").slice(0, 2000);
                                                if (resultText)
                                                    postToFeed(session_id, dbUrl, `📄 Result: ${resultText}`);
                                            }
                                        }
                                        catch { }
                                    }
                                });
                                proc.stderr.on("data", (chunk) => {
                                    const text = chunk.toString();
                                    log("[stderr] " + text);
                                    if (text.includes("Error") || text.includes("error") || text.includes("failed")) {
                                        postToFeed(session_id, dbUrl, `⚠️ stderr: ${text.slice(0, 500)}`, "system", "console");
                                    }
                                });
                                proc.on("close", (code) => {
                                    clearTimeout(timer);
                                    try {
                                        fs.unlinkSync(rulesFile);
                                    }
                                    catch { }
                                    postToFeed(session_id, dbUrl, `✅ Process ${taskId} exited with code ${code}. Debug log: ${debugLogPath}`);
                                });
                            }
                            catch (err) {
                                console.error(`[code_task] Error in async spawn: ${err.message}`);
                                postToFeed(session_id, dbUrl, `❌ Task ${taskId} failed to start: ${err.message}`);
                            }
                        })().catch((err) => {
                            console.error(`[code_task] Unhandled rejection: ${err.message}`);
                        }); // Fire and forget
                        // Return IMMEDIATELY with task_id
                        return {
                            content: [{
                                    type: "text",
                                    text: JSON.stringify({
                                        ok: true,
                                        task_id: taskId,
                                        status: "spawned",
                                        debug_log: debugLogPath,
                                        message: `Process spawned. Poll get_task_log('${taskId}') or read ${debugLogPath} for output.`
                                    })
                                }]
                        };
                    }
                    else {
                        // cline driver
                        const clinerules = path.join(working_dir, ".clinerules");
                        fs.writeFileSync(clinerules, rules);
                        // Spawn ASYNC - return immediately
                        (async () => {
                            try {
                                const memUsage = process.memoryUsage();
                                console.log(`[code_task] Starting task ${taskId}. Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
                                const proc = (0, child_process_1.spawn)("/home/david/.npm-local/bin/cline", ["-y", "--json", "--timeout", String(timeout_seconds), instruction], {
                                    cwd: working_dir,
                                    env: {
                                        ...process.env,
                                        CLINE_COMMAND_PERMISSIONS: JSON.stringify({
                                            allow: ["npm *", "git *", "node *", "npx *", "yarn *", "pnpm *"],
                                            deny: ["rm -rf /", "sudo *"],
                                        }),
                                    },
                                });
                                const outputLines = [];
                                const timer = setTimeout(() => { proc.kill("SIGTERM"); }, timeout_seconds * 1000);
                                proc.stdout.on("data", (chunk) => {
                                    const lines = chunk.toString().split("\n");
                                    for (const line of lines) {
                                        if (!line.trim())
                                            continue;
                                        log(line);
                                        try {
                                            const parsed = JSON.parse(line);
                                            if (parsed.type === "say" && !parsed.partial) {
                                                outputLines.push(parsed.text || "");
                                                if (parsed.say === "text") {
                                                    postToFeed(session_id, dbUrl, `💭 ${(parsed.text || "").slice(0, 500)}`);
                                                }
                                                else if (parsed.say === "tool") {
                                                    postToFeed(session_id, dbUrl, `🔧 ${(parsed.text || "").slice(0, 300)}`);
                                                }
                                                else if (parsed.say === "completion_result") {
                                                    postToFeed(session_id, dbUrl, `✅ Done: ${(parsed.text || "").slice(0, 1000)}`);
                                                }
                                            }
                                        }
                                        catch { }
                                    }
                                });
                                proc.stderr.on("data", (chunk) => log("[stderr] " + chunk.toString()));
                                proc.on("close", (code) => {
                                    clearTimeout(timer);
                                    try {
                                        fs.unlinkSync(clinerules);
                                    }
                                    catch { }
                                    postToFeed(session_id, dbUrl, `✅ Process ${taskId} exited with code ${code}`);
                                });
                            }
                            catch (err) {
                                console.error(`[code_task] Error in async spawn: ${err.message}`);
                                postToFeed(session_id, dbUrl, `❌ Task ${taskId} failed to start: ${err.message}`);
                            }
                        })().catch((err) => {
                            console.error(`[code_task] Unhandled rejection: ${err.message}`);
                        }); // Fire and forget
                        // Return IMMEDIATELY with task_id
                        return {
                            content: [{
                                    type: "text",
                                    text: JSON.stringify({
                                        ok: true,
                                        task_id: taskId,
                                        status: "spawned",
                                        message: `Process spawned. Poll get_task_log('${taskId}') for output.`
                                    })
                                }]
                        };
                    }
                }
                case "get_task_log": {
                    const { task_id } = args;
                    const logs = taskLogs.get(task_id) || [];
                    return { content: [{ type: "text", text: JSON.stringify({ task_id, lines: logs }) }] };
                }
                case "run_tests": {
                    const { working_dir, test_cmd } = args;
                    let cmd = test_cmd;
                    if (!cmd) {
                        try {
                            const proj = JSON.parse(fs.readFileSync(path.join(working_dir, ".project.json"), "utf8"));
                            cmd = proj.testCmd;
                        }
                        catch { }
                    }
                    if (!cmd)
                        cmd = process.env.TEST_CMD || "npm test";
                    const r = (0, child_process_1.spawnSync)(cmd, { shell: true, cwd: working_dir, encoding: "utf8" });
                    const output = (r.stdout || "") + (r.stderr || "");
                    return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
                }
                case "run_build": {
                    const { working_dir, build_cmd } = args;
                    let cmd = build_cmd;
                    if (!cmd) {
                        try {
                            const proj = JSON.parse(fs.readFileSync(path.join(working_dir, ".project.json"), "utf8"));
                            cmd = proj.buildCmd;
                        }
                        catch { }
                    }
                    if (!cmd)
                        cmd = process.env.BUILD_CMD || "npm run build";
                    const r = (0, child_process_1.spawnSync)(cmd, { shell: true, cwd: working_dir, encoding: "utf8" });
                    const output = (r.stdout || "") + (r.stderr || "");
                    return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
                }
                case "get_diff": {
                    const { working_dir, from_ref = "HEAD", to_ref } = args;
                    const diffArgs = to_ref ? `${from_ref} ${to_ref}` : from_ref;
                    const r = (0, child_process_1.spawnSync)("git", ["diff", ...diffArgs.split(" ")], { cwd: working_dir, encoding: "utf8" });
                    return { content: [{ type: "text", text: JSON.stringify({ output: r.stdout + r.stderr, exit_code: r.status ?? -1 }) }] };
                }
                case "get_repo_state": {
                    const { working_dir } = args;
                    const run = (args) => (0, child_process_1.spawnSync)("git", args, { cwd: working_dir, encoding: "utf8" });
                    const branchR = run(["rev-parse", "--abbrev-ref", "HEAD"]);
                    const branch = branchR.stdout.trim();
                    const statusR = run(["status", "--short"]);
                    const dirty = statusR.stdout.trim().length > 0;
                    const stagedR = run(["diff", "--cached", "--name-only"]);
                    const staged_files = stagedR.stdout.trim().split("\n").filter(Boolean);
                    const logR = run(["log", "--oneline", "-10"]);
                    const recent_commits = logR.stdout.trim().split("\n").filter(Boolean).map((line) => {
                        const [hash, ...rest] = line.split(" ");
                        return { hash, subject: rest.join(" ") };
                    });
                    return {
                        content: [{
                                type: "text",
                                text: JSON.stringify({ branch, dirty, staged_files, recent_commits }),
                            }],
                    };
                }
                case "cache_read": {
                    const { cache_key } = args;
                    const dbUrl = process.env.OPS_DB_URL;
                    const result = await withDbClient(dbUrl, async (client) => {
                        const rowRes = await client.query(`SELECT summary, content_hash, source_updated, cached_at
               FROM project_context_cache
               WHERE cache_key = $1`, [cache_key]);
                        if (rowRes.rows.length === 0) {
                            return { found: false };
                        }
                        await client.query(`UPDATE project_context_cache SET last_checked = now() WHERE cache_key = $1`, [cache_key]);
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
                    const { cache_key, source_type, content_hash, source_updated = null, summary } = args;
                    const dbUrl = process.env.OPS_DB_URL;
                    const result = await withDbClient(dbUrl, async (client) => {
                        await client.query(`INSERT INTO project_context_cache
                 (cache_key, source_type, content_hash, source_updated, summary, cached_at, last_checked)
               VALUES ($1, $2, $3, $4, $5, now(), now())
               ON CONFLICT (cache_key) DO UPDATE SET
                 source_type = EXCLUDED.source_type,
                 content_hash = EXCLUDED.content_hash,
                 source_updated = EXCLUDED.source_updated,
                 summary = EXCLUDED.summary,
                 cached_at = now(),
                 last_checked = now()`, [cache_key, source_type, content_hash, source_updated || null, summary]);
                        return { ok: true };
                    });
                    return { content: [{ type: "text", text: JSON.stringify(result) }] };
                }
                case "listen_for_approval": {
                    const { session_id, timeout_seconds = 1800 } = args;
                    const dbUrl = process.env.OPS_DB_URL;
                    const result = await withDbClient(dbUrl, async (client) => {
                        const channel = `session:${session_id}`;
                        const quotedChannel = `"${channel.replace(/"/g, '""')}"`;
                        await client.query(`LISTEN ${quotedChannel}`);
                        try {
                            const notified = await new Promise((resolve) => {
                                const timer = setTimeout(() => {
                                    client.removeListener("notification", onNotification);
                                    resolve(false);
                                }, Math.max(1, Number(timeout_seconds)) * 1000);
                                const onNotification = (msg) => {
                                    if (msg.channel === channel) {
                                        clearTimeout(timer);
                                        client.removeListener("notification", onNotification);
                                        resolve(true);
                                    }
                                };
                                client.on("notification", onNotification);
                            });
                            if (!notified) {
                                return { approved: false, timed_out: true };
                            }
                            const approvalRes = await client.query(`SELECT content
                 FROM session_messages
                 WHERE session_id = $1
                   AND message_type = 'approval_response'
                   AND role != 'dev_lead'
                 ORDER BY created_at DESC
                 LIMIT 1`, [session_id]);
                            if (approvalRes.rows.length === 0) {
                                return { approved: false };
                            }
                            return { approved: true, content: approvalRes.rows[0].content };
                        }
                        finally {
                            await client.query(`UNLISTEN ${quotedChannel}`).catch(() => { });
                        }
                    });
                    return { content: [{ type: "text", text: JSON.stringify(result) }] };
                }
                case "git_status": {
                    const { repo } = args;
                    const working_dir = `/home/david/${repo}`;
                    const branchR = (0, child_process_1.spawnSync)("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: working_dir, encoding: "utf8" });
                    const branch = branchR.stdout.trim();
                    const statusR = (0, child_process_1.spawnSync)("git", ["status", "--short"], { cwd: working_dir, encoding: "utf8" });
                    const staged = [];
                    const unstaged = [];
                    const untracked = [];
                    for (const line of statusR.stdout.split("\n")) {
                        if (!line)
                            continue;
                        const indexChar = line[0];
                        const wtChar = line[1];
                        const file = line.slice(3);
                        if (indexChar === "?" && wtChar === "?") {
                            untracked.push(file);
                        }
                        else {
                            if (indexChar !== " " && indexChar !== "?")
                                staged.push(file);
                            if (wtChar !== " " && wtChar !== "?")
                                unstaged.push(file);
                        }
                    }
                    return { content: [{ type: "text", text: JSON.stringify({ branch, staged, unstaged, untracked, exit_code: branchR.status ?? -1 }) }] };
                }
                case "git_checkout": {
                    const { repo, branch, create = false } = args;
                    const working_dir = `/home/david/${repo}`;
                    const gitArgs = create ? ["checkout", "-b", branch] : ["checkout", branch];
                    const r = (0, child_process_1.spawnSync)("git", gitArgs, { cwd: working_dir, encoding: "utf8" });
                    const output = (r.stdout || "") + (r.stderr || "");
                    return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
                }
                case "git_add": {
                    const { repo, files } = args;
                    const working_dir = `/home/david/${repo}`;
                    const r = (0, child_process_1.spawnSync)("git", ["add", ...files], { cwd: working_dir, encoding: "utf8" });
                    const output = (r.stdout || "") + (r.stderr || "");
                    return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
                }
                case "git_commit": {
                    const { repo, message } = args;
                    const working_dir = `/home/david/${repo}`;
                    const gitEnv = {
                        ...process.env,
                        GIT_AUTHOR_NAME: "Dev-Lead Agent",
                        GIT_AUTHOR_EMAIL: "dev-lead@zennya.app",
                        GIT_COMMITTER_NAME: "Dev-Lead Agent",
                        GIT_COMMITTER_EMAIL: "dev-lead@zennya.app",
                    };
                    const r = (0, child_process_1.spawnSync)("git", ["commit", "-m", message], { cwd: working_dir, encoding: "utf8", env: gitEnv });
                    const output = (r.stdout || "") + (r.stderr || "");
                    return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
                }
                case "git_push": {
                    const { repo, branch, force = false } = args;
                    const working_dir = `/home/david/${repo}`;
                    const gitArgs = ["push"];
                    if (force)
                        gitArgs.push("--force");
                    gitArgs.push("origin");
                    if (branch)
                        gitArgs.push(branch);
                    const r = (0, child_process_1.spawnSync)("git", gitArgs, { cwd: working_dir, encoding: "utf8" });
                    const output = (r.stdout || "") + (r.stderr || "");
                    return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
                }
                case "git_merge": {
                    const { repo, branch, no_ff = true } = args;
                    const working_dir = `/home/david/${repo}`;
                    const gitArgs = ["merge"];
                    if (no_ff)
                        gitArgs.push("--no-ff");
                    gitArgs.push(branch);
                    const r = (0, child_process_1.spawnSync)("git", gitArgs, { cwd: working_dir, encoding: "utf8" });
                    const output = (r.stdout || "") + (r.stderr || "");
                    return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
                }
                case "git_pull": {
                    const { repo } = args;
                    const working_dir = `/home/david/${repo}`;
                    const r = (0, child_process_1.spawnSync)("git", ["pull", "--rebase", "origin"], { cwd: working_dir, encoding: "utf8" });
                    const output = (r.stdout || "") + (r.stderr || "");
                    return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
                }
                case "create_git_worktree": {
                    const { repo, base_branch = "main", worktree_id } = args;
                    const repoDir = `/home/david/${repo}`;
                    const id = worktree_id || `wt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
                    const worktreePath = `/tmp/${repo}-${id}`;
                    const branchName = `worktree/${id}`;
                    // Ensure base branch is up to date
                    (0, child_process_1.spawnSync)("git", ["fetch", "origin", base_branch], { cwd: repoDir, encoding: "utf8" });
                    // Create worktree with a new branch based on the base branch
                    const r = (0, child_process_1.spawnSync)("git", ["worktree", "add", "-b", branchName, worktreePath, `origin/${base_branch}`], {
                        cwd: repoDir,
                        encoding: "utf8",
                    });
                    const output = (r.stdout || "") + (r.stderr || "");
                    if (r.status !== 0) {
                        return { content: [{ type: "text", text: JSON.stringify({ success: false, output, exit_code: r.status ?? -1 }) }] };
                    }
                    return {
                        content: [{ type: "text", text: JSON.stringify({
                                    success: true,
                                    worktree_path: worktreePath,
                                    branch: branchName,
                                    base_branch,
                                    repo_dir: repoDir,
                                    output,
                                }) }],
                    };
                }
                case "delete_git_worktree": {
                    const { worktree_path, delete_branch = false } = args;
                    // Detect which branch the worktree is on before removing
                    let worktreeBranch = null;
                    if (delete_branch) {
                        const branchR = (0, child_process_1.spawnSync)("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree_path, encoding: "utf8" });
                        worktreeBranch = branchR.status === 0 ? branchR.stdout.trim() : null;
                    }
                    // Find the main repo dir from the worktree
                    const mainR = (0, child_process_1.spawnSync)("git", ["worktree", "list", "--porcelain"], { cwd: worktree_path, encoding: "utf8" });
                    let mainRepoDir = null;
                    if (mainR.status === 0) {
                        // First "worktree" entry in porcelain output is the main working tree
                        const match = mainR.stdout.match(/^worktree (.+)$/m);
                        if (match)
                            mainRepoDir = match[1];
                    }
                    // Remove the worktree
                    const removeR = (0, child_process_1.spawnSync)("git", ["worktree", "remove", worktree_path, "--force"], {
                        cwd: mainRepoDir || worktree_path,
                        encoding: "utf8",
                    });
                    const output = (removeR.stdout || "") + (removeR.stderr || "");
                    // Optionally delete the branch
                    let branchDeleted = false;
                    if (delete_branch && worktreeBranch && mainRepoDir && removeR.status === 0) {
                        const delR = (0, child_process_1.spawnSync)("git", ["branch", "-D", worktreeBranch], { cwd: mainRepoDir, encoding: "utf8" });
                        branchDeleted = delR.status === 0;
                    }
                    return {
                        content: [{ type: "text", text: JSON.stringify({
                                    success: removeR.status === 0,
                                    output,
                                    branch_deleted: branchDeleted,
                                    exit_code: removeR.status ?? -1,
                                }) }],
                    };
                }
                case "list_git_worktrees": {
                    const { repo } = args;
                    const repoDir = `/home/david/${repo}`;
                    const r = (0, child_process_1.spawnSync)("git", ["worktree", "list", "--porcelain"], { cwd: repoDir, encoding: "utf8" });
                    if (r.status !== 0) {
                        const output = (r.stdout || "") + (r.stderr || "");
                        return { content: [{ type: "text", text: JSON.stringify({ success: false, output, exit_code: r.status ?? -1 }) }] };
                    }
                    // Parse porcelain output into structured list
                    const worktrees = [];
                    let current = {};
                    for (const line of r.stdout.split("\n")) {
                        if (line.startsWith("worktree ")) {
                            if (current.path)
                                worktrees.push(current);
                            current = { path: line.slice(9), head: "", branch: null, bare: false, detached: false };
                        }
                        else if (line.startsWith("HEAD ")) {
                            current.head = line.slice(5);
                        }
                        else if (line.startsWith("branch ")) {
                            current.branch = line.slice(7);
                        }
                        else if (line === "bare") {
                            current.bare = true;
                        }
                        else if (line === "detached") {
                            current.detached = true;
                        }
                    }
                    if (current.path)
                        worktrees.push(current);
                    return { content: [{ type: "text", text: JSON.stringify({ success: true, worktrees }) }] };
                }
                case "chat_session": {
                    const { message, session_id: chatSessionId, claude_session_id: existingClaudeSessionId, working_dir: chatWorkingDir = "/home/david/dev-session-app", } = args;
                    const dbUrl = process.env.OPS_DB_URL ?? "";
                    // Auto-bootstrap: inject project context on the first message of an interactive session
                    let systemContextFile = null;
                    if (chatSessionId && dbUrl && !existingClaudeSessionId) {
                        try {
                            const bootstrapClient = new pg_1.Client({ connectionString: dbUrl });
                            await bootstrapClient.connect();
                            const countRes = await bootstrapClient.query("SELECT COUNT(*) AS count FROM session_messages WHERE session_id = $1 AND role = 'user'", [chatSessionId]);
                            const msgCount = parseInt(countRes.rows[0]?.count ?? "0", 10);
                            if (msgCount <= 1) {
                                const projRes = await bootstrapClient.query(`SELECT p.display_name, p.description, p.project_id, p.default_container
                   FROM sessions s
                   JOIN projects p ON p.project_id = s.project_id
                   WHERE s.session_id = $1`, [chatSessionId]);
                                if (projRes.rows.length > 0) {
                                    const proj = projRes.rows[0];
                                    const repo = proj.project_id;
                                    const contextMsg = `You are Claude Code running in an interactive dev session. Project: ${proj.display_name} (${repo}). Path: /home/david/${repo}. Container: ${proj.default_container}. Description: ${proj.description}. Help the developer with code questions, debugging, and changes in this project.`;
                                    // Save context to session_messages so UI can optionally hide it
                                    const bootstrapInsert = await bootstrapClient.query("INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING message_id, created_at", [chatSessionId, "system", contextMsg, "system_context"]);
                                    if (bootstrapInsert.rows[0]) {
                                        await notifySessionMessage(bootstrapClient, chatSessionId, {
                                            id: bootstrapInsert.rows[0].message_id,
                                            message_id: bootstrapInsert.rows[0].message_id,
                                            session_id: chatSessionId,
                                            role: "system",
                                            message_type: "system_context",
                                            content: contextMsg,
                                            created_at: bootstrapInsert.rows[0].created_at,
                                        }).catch(() => { });
                                    }
                                    // Write temp file for --append-system-prompt-file
                                    systemContextFile = `/tmp/container-mcp-ctx-${chatSessionId}.md`;
                                    fs.writeFileSync(systemContextFile, contextMsg);
                                    console.log(`[chat_session] bootstrap context injected for session ${chatSessionId} (project: ${repo})`);
                                }
                            }
                            await bootstrapClient.end().catch(() => { });
                        }
                        catch (e) {
                            console.warn("[chat_session] bootstrap error:", e.message);
                        }
                    }
                    // Note: user message is already saved by the dev-session-app chat route.
                    // No need to echo it again here.
                    const claudeArgs = [
                        "-p", message,
                        "--output-format", "stream-json",
                        "--verbose",
                        "--dangerously-skip-permissions",
                    ];
                    if (existingClaudeSessionId) {
                        claudeArgs.push("--resume", existingClaudeSessionId);
                    }
                    if (systemContextFile) {
                        claudeArgs.push("--append-system-prompt-file", systemContextFile);
                    }
                    // Note: working-dir is set via cwd in spawn options
                    const chatResult = await new Promise((resolve) => {
                        const proc = (0, child_process_1.spawn)("claude", claudeArgs, {
                            cwd: chatWorkingDir,
                            env: process.env,
                            stdio: ["ignore", "pipe", "pipe"],
                        });
                        let fullAssistantText = "";
                        let resultClaudeSessionId = null;
                        let tokensUsed = 0;
                        let costUsd = 0;
                        // Timeout: 10 minutes for interactive chat
                        const timer = setTimeout(() => {
                            proc.kill("SIGTERM");
                        }, 600_000);
                        proc.stdout.on("data", (chunk) => {
                            const lines = chunk.toString().split("\n");
                            for (const line of lines) {
                                if (!line.trim())
                                    continue;
                                try {
                                    const parsed = JSON.parse(line);
                                    if (parsed.type === "assistant") {
                                        const content = parsed.message?.content || [];
                                        for (const block of content) {
                                            if (block.type === "text" && block.text?.trim()) {
                                                const text = block.text.trim();
                                                fullAssistantText += text + "\n";
                                                // Post each assistant text block as execution_log
                                                if (chatSessionId && text.length > 0) {
                                                    void (async () => {
                                                        if (!chatSessionId || !dbUrl)
                                                            return;
                                                        const key = `${chatSessionId}::${dbUrl}`;
                                                        if (!_feedClients.has(key)) {
                                                            const client = new pg_1.Client({ connectionString: dbUrl });
                                                            await client.connect();
                                                            _feedClients.set(key, { client, queue: Promise.resolve() });
                                                        }
                                                        const entry = _feedClients.get(key);
                                                        entry.queue = entry.queue.then(async () => {
                                                            try {
                                                                const insertRes = await entry.client.query("INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING message_id, created_at", [chatSessionId, "coding_agent", text, "execution_log"]);
                                                                if (insertRes.rows[0]) {
                                                                    await notifySessionMessage(entry.client, chatSessionId, {
                                                                        id: insertRes.rows[0].message_id,
                                                                        message_id: insertRes.rows[0].message_id,
                                                                        session_id: chatSessionId,
                                                                        role: "coding_agent",
                                                                        message_type: "execution_log",
                                                                        content: text,
                                                                        created_at: insertRes.rows[0].created_at,
                                                                    }).catch(() => { });
                                                                }
                                                            }
                                                            catch (e) {
                                                                console.error("chat_session postToFeed error:", e.message);
                                                            }
                                                        });
                                                    })();
                                                }
                                            }
                                            else if (block.type === "tool_use" && chatSessionId && dbUrl) {
                                                postToFeed(chatSessionId, dbUrl, `🔧 \`${block.name}\` ${JSON.stringify(block.input || {}).slice(0, 200)}`, "coding_agent", "execution_log");
                                            }
                                        }
                                    }
                                    else if (parsed.type === "result") {
                                        // Extract the claude session_id from the result event
                                        resultClaudeSessionId = parsed.session_id || null;
                                        if (parsed.usage) {
                                            const inputTokens = parsed.usage.input_tokens || 0;
                                            const outputTokens = parsed.usage.output_tokens || 0;
                                            tokensUsed = inputTokens + outputTokens;
                                            costUsd = (inputTokens / 1_000_000 * 3) + (outputTokens / 1_000_000 * 15);
                                        }
                                        const resultText = (parsed.result || parsed.output || "");
                                        if (resultText && chatSessionId && dbUrl) {
                                            postToFeed(chatSessionId, dbUrl, `✅ Done`, "coding_agent", "execution_log");
                                        }
                                    }
                                }
                                catch {
                                    // ignore malformed JSON lines
                                }
                            }
                        });
                        proc.stderr.on("data", (chunk) => {
                            console.error("[chat_session] stderr:", chunk.toString().slice(0, 200));
                        });
                        proc.on("close", (code) => {
                            clearTimeout(timer);
                            if (systemContextFile) {
                                try {
                                    fs.unlinkSync(systemContextFile);
                                }
                                catch { }
                            }
                            // Post final response as a chat message (not execution_log) so it shows as a bubble
                            if (chatSessionId && fullAssistantText.trim()) {
                                void (async () => {
                                    if (!chatSessionId || !dbUrl)
                                        return;
                                    const key = `${chatSessionId}::${dbUrl}`;
                                    if (!_feedClients.has(key)) {
                                        const client = new pg_1.Client({ connectionString: dbUrl });
                                        await client.connect();
                                        _feedClients.set(key, { client, queue: Promise.resolve() });
                                    }
                                    const entry = _feedClients.get(key);
                                    entry.queue = entry.queue.then(async () => {
                                        try {
                                            const insertRes = await entry.client.query("INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING message_id, created_at", [chatSessionId, "coding_agent", fullAssistantText.trim(), "chat"]);
                                            if (insertRes.rows[0]) {
                                                await notifySessionMessage(entry.client, chatSessionId, {
                                                    id: insertRes.rows[0].message_id,
                                                    message_id: insertRes.rows[0].message_id,
                                                    session_id: chatSessionId,
                                                    role: "coding_agent",
                                                    message_type: "chat",
                                                    content: fullAssistantText.trim(),
                                                    created_at: insertRes.rows[0].created_at,
                                                }).catch(() => { });
                                            }
                                        }
                                        catch (e) {
                                            console.error("chat_session final chat error:", e.message);
                                        }
                                    });
                                    // Update claude_session_id in sessions table
                                    if (resultClaudeSessionId) {
                                        entry.queue = entry.queue.then(async () => {
                                            try {
                                                await entry.client.query("UPDATE sessions SET claude_session_id = $1, updated_at = now() WHERE session_id = $2", [resultClaudeSessionId, chatSessionId]);
                                            }
                                            catch (e) {
                                                console.error("chat_session update claude_session_id error:", e.message);
                                            }
                                        });
                                    }
                                })();
                            }
                            if (tokensUsed > 0 && chatSessionId && dbUrl) {
                                void withDbClient(dbUrl, async (client) => {
                                    await client.query(`UPDATE sessions SET token_usage = COALESCE(token_usage, 0) + $1, cost_usd = COALESCE(cost_usd, 0) + $2 WHERE session_id = $3`, [tokensUsed, costUsd, chatSessionId]);
                                }).catch((err) => console.error('[token-usage] Failed to update token usage:', err));
                            }
                            resolve({
                                claude_session_id: resultClaudeSessionId,
                                response: fullAssistantText.trim(),
                                tokens_used: tokensUsed,
                            });
                        });
                    });
                    return {
                        content: [{ type: "text", text: JSON.stringify(chatResult) }],
                    };
                }
                case "spawn_dev_lead": {
                    // POST to gateway /tools/invoke (async — returns immediately with childSessionKey)
                    const { session_id: sessionId } = args;
                    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://172.17.0.1:18789";
                    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
                    try {
                        const resp = await fetch(`${gatewayUrl}/tools/invoke`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Authorization": `Bearer ${gatewayToken}`,
                            },
                            body: JSON.stringify({
                                tool: "sessions_spawn",
                                args: { agentId: "dev-lead", task: await buildSpawnMessage(sessionId, process.env.OPS_DB_URL ?? ''), cwd: "/home/openclaw/agents/dev-lead" },
                            }),
                        });
                        if (!resp.ok) {
                            const text = await resp.text();
                            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Gateway ${resp.status}: ${text}` }) }] };
                        }
                        const parsed = await resp.json().catch(() => ({}));
                        const childSessionKey = parsed?.childSessionKey ?? parsed?.session_key ?? null;
                        return { content: [{ type: "text", text: JSON.stringify({ ok: true, session_id: sessionId, childSessionKey }) }] };
                    }
                    catch (fetchErr) {
                        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: fetchErr.message }) }] };
                    }
                }
                case "create_session": {
                    const { title, repo, container: sessionContainer = "dev-david", task_brief, slack_thread_url, jira_keys, } = args;
                    const dbUrl = process.env.OPS_DB_URL;
                    if (!dbUrl) {
                        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
                    }
                    // Generate session_id: sess-{jirakey_no_dash}-{timestamp}
                    const firstKey = jira_keys?.split(",")[0]?.trim().toLowerCase().replace(/-/g, "") ?? "";
                    const ts = Date.now();
                    const sessionId = firstKey
                        ? `sess-${firstKey}-${ts}`
                        : `sess-${(0, crypto_1.randomUUID)().slice(0, 8)}-${ts}`;
                    const sessionUrl = `https://dev-sessions.ash.zennya.app/sessions/${sessionId}`;
                    // Parse jira keys into Postgres array literal e.g. {ZI-18820,ZI-18821}
                    const jiraKeysArr = jira_keys
                        ? `{${jira_keys.split(",").map((k) => k.trim()).join(",")}}`
                        : null;
                    try {
                        await withDbClient(dbUrl, async (client) => {
                            // Step 1: INSERT session row
                            await client.query(`INSERT INTO sessions (session_id, project_id, container, repo, status, title, prompt_preview, jira_issue_keys, slack_thread_url, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'active', $5, $6, $7::text[], $8, now(), now())`, [sessionId, repo, sessionContainer, repo, title, task_brief.slice(0, 500), jiraKeysArr, slack_thread_url || null]);
                            // Step 2: INSERT task_brief message
                            const msgId = `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
                            await client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
                 VALUES ($1, $2, 'user', $3, 'task_brief', now())`, [msgId, sessionId, task_brief]);
                        });
                        // Step 3: Pre-populate project_context_cache (non-blocking, don't fail session on error)
                        try {
                            const parsedJiraKeys = jira_keys
                                ? jira_keys.split(",").map((k) => k.trim()).filter(Boolean)
                                : [];
                            const projRow = await withDbClient(dbUrl, async (client) => {
                                const r = await client.query(`SELECT confluence_root_id FROM projects WHERE project_id = $1`, [repo]);
                                return r.rows[0] ?? null;
                            });
                            const confluenceRootId = projRow?.confluence_root_id ?? null;
                            await populateCacheForProject(dbUrl, parsedJiraKeys, confluenceRootId);
                            console.log(`[create_session] cache warmed: jira=${parsedJiraKeys.join(",") || "none"} confluence=${confluenceRootId ?? "none"}`);
                        }
                        catch (cacheErr) {
                            console.warn(`[create_session] cache warm failed (non-fatal): ${cacheErr.message}`);
                        }
                        // Step 4: Spawn dev-lead via gateway /tools/invoke (async — returns immediately)
                        const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://172.17.0.1:18789";
                        const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
                        let spawnOk = false;
                        let spawnError = "";
                        let childSessionKey = null;
                        try {
                            const resp = await fetch(`${gatewayUrl}/tools/invoke`, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                    "Authorization": `Bearer ${gatewayToken}`,
                                },
                                body: JSON.stringify({
                                    tool: "sessions_spawn",
                                    args: { agentId: "dev-lead", task: await buildSpawnMessage(sessionId, dbUrl), cwd: "/home/openclaw/agents/dev-lead" },
                                }),
                            });
                            if (!resp.ok) {
                                const text = await resp.text();
                                spawnError = `Gateway ${resp.status}: ${text}`;
                            }
                            else {
                                const parsed = await resp.json().catch(() => ({}));
                                childSessionKey = parsed?.childSessionKey ?? parsed?.session_key ?? null;
                                spawnOk = true;
                            }
                        }
                        catch (fetchErr) {
                            spawnError = fetchErr.message;
                        }
                        if (!spawnOk) {
                            // Session was created but spawn failed — log it to the session feed
                            await withDbClient(dbUrl, async (client) => {
                                await client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
                   VALUES (gen_random_uuid(), $1, 'dev_lead', $2, 'console', now())`, [sessionId, `⚠️ Session created but spawn_dev_lead failed: ${spawnError}`]);
                            }).catch(() => { });
                            return { content: [{ type: "text", text: JSON.stringify({ ok: false, session_id: sessionId, session_url: sessionUrl, error: `spawn failed: ${spawnError}` }) }] };
                        }
                        return { content: [{ type: "text", text: JSON.stringify({ ok: true, session_id: sessionId, session_url: sessionUrl, childSessionKey }) }] };
                    }
                    catch (err) {
                        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
                    }
                }
                case "warm_cache_for_repos": {
                    const { repos: targetRepos } = args;
                    const repoList = Array.isArray(targetRepos) && targetRepos.length > 0
                        ? targetRepos
                        : ["dev-session-app", "container-mcp", "ash-dashboard"];
                    const dbUrl = process.env.OPS_DB_URL;
                    if (!dbUrl) {
                        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
                    }
                    const results = {};
                    for (const repoId of repoList) {
                        try {
                            const projRow = await withDbClient(dbUrl, async (client) => {
                                const r = await client.query(`SELECT confluence_root_id FROM projects WHERE project_id = $1`, [repoId]);
                                return r.rows[0] ?? null;
                            });
                            if (!projRow) {
                                results[repoId] = "not found in projects table";
                                continue;
                            }
                            const confluenceRootId = projRow.confluence_root_id ?? null;
                            await populateCacheForProject(dbUrl, [], confluenceRootId);
                            results[repoId] = `ok (confluence: ${confluenceRootId ?? "none"})`;
                        }
                        catch (e) {
                            results[repoId] = `error: ${e.message}`;
                        }
                    }
                    return { content: [{ type: "text", text: JSON.stringify({ ok: true, results }) }] };
                }
                case "deploy_project": {
                    const { project_id, session_id: deploySessionId } = args;
                    const result = await (0, deploy_project_js_1.deployProject)(project_id, deploySessionId);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "post_message": {
                    const { session_id: pmSessionId, role: pmRole = "dev_lead", content: pmContent, message_type: pmMsgType = "status_change", metadata: pmMetadata } = args;
                    const dbUrl = process.env.OPS_DB_URL;
                    if (!dbUrl)
                        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
                    const row = await withDbClient(dbUrl, async (client) => {
                        const metadataJson = pmMetadata ? JSON.stringify(pmMetadata) : null;
                        const insertRes = await client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, metadata, created_at)
               VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, now())
               RETURNING message_id, created_at`, [pmSessionId, pmRole, pmContent, pmMsgType, metadataJson]);
                        const inserted = insertRes.rows[0];
                        if (inserted) {
                            const notifyPayload = JSON.stringify({
                                id: inserted.message_id, message_id: inserted.message_id,
                                session_id: pmSessionId, role: pmRole, message_type: pmMsgType,
                                content: pmContent, created_at: inserted.created_at,
                            });
                            const safeId = pmSessionId.replace(/-/g, "_");
                            await client.query("SELECT pg_notify($1, $2)", [`session_messages_${safeId}`, notifyPayload]).catch(() => { });
                            await client.query("SELECT pg_notify($1, $2)", [`session_messages`, notifyPayload]).catch(() => { });
                            await client.query("SELECT pg_notify($1, $2)", [`session:${pmSessionId}`, notifyPayload]).catch(() => { });
                        }
                        return inserted;
                    });
                    return { content: [{ type: "text", text: JSON.stringify({ ok: true, message_id: row?.message_id }) }] };
                }
                case "create_project": {
                    const { project_id: projectId, display_name, description: projDescription, working_dir: inputWorkingDir, default_container, build_cmd: inputBuildCmd, deploy_cmd: inputDeployCmd, smoke_url: inputSmokeUrl, jira_issue_keys: jiraKeysStr, confluence_root_id, } = args;
                    const dbUrl = process.env.OPS_DB_URL;
                    if (!dbUrl) {
                        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
                    }
                    // Resolve working_dir: explicit > auto-detect from candidate dirs
                    let workingDir = inputWorkingDir || null;
                    if (!workingDir) {
                        for (const candidate of [`/home/david/${projectId}`, `/home/openclaw/apps/${projectId}`, `/opt/${projectId}`]) {
                            if (fs.existsSync(candidate)) {
                                workingDir = candidate;
                                break;
                            }
                        }
                    }
                    // Auto-detect build/deploy commands if not provided and working_dir exists
                    let buildCmd = inputBuildCmd || null;
                    let deployCmd = inputDeployCmd || null;
                    if (workingDir && (!buildCmd || !deployCmd)) {
                        const hasSwarmYml = fs.existsSync(path.join(workingDir, 'swarm.yml'));
                        const hasDockerfile = fs.existsSync(path.join(workingDir, 'Dockerfile'));
                        const hasPkgJson = fs.existsSync(path.join(workingDir, 'package.json'));
                        const hasRequirements = fs.existsSync(path.join(workingDir, 'requirements.txt'));
                        const hasPyproject = fs.existsSync(path.join(workingDir, 'pyproject.toml'));
                        if (!buildCmd || !deployCmd) {
                            let detectedBuild = null;
                            let detectedDeploy = null;
                            if (hasSwarmYml) {
                                detectedBuild = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
                                detectedDeploy = `docker stack deploy -c ${workingDir}/swarm.yml ${projectId}`;
                            }
                            else if (hasDockerfile) {
                                detectedBuild = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
                                detectedDeploy = `docker service update --image ${projectId}:latest prod_${projectId} || docker service update --image ${projectId}:latest ${projectId}`;
                            }
                            else if (hasPkgJson) {
                                let pkgJson = {};
                                try {
                                    pkgJson = JSON.parse(fs.readFileSync(path.join(workingDir, 'package.json'), 'utf8'));
                                }
                                catch { }
                                const deps = (pkgJson?.dependencies ?? {});
                                const devDeps = (pkgJson?.devDependencies ?? {});
                                const isNext = Boolean(deps.next ?? devDeps.next);
                                if (isNext) {
                                    detectedBuild = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
                                    detectedDeploy = `docker service update --image ${projectId}:latest prod_${projectId} || docker service update --image ${projectId}:latest ${projectId}`;
                                }
                                else {
                                    detectedBuild = `cd ${workingDir} && npm install && npm run build`;
                                    detectedDeploy = `pkill -f "node dist/index.js" 2>/dev/null || true; nohup node ${workingDir}/dist/index.js > /tmp/${projectId}.log 2>&1 &`;
                                }
                            }
                            else if (hasRequirements || hasPyproject) {
                                detectedBuild = `cd ${workingDir} && pip install -r ${hasRequirements ? 'requirements.txt' : '.'} -q`;
                                detectedDeploy = `pkill -f "${workingDir}/main.py" 2>/dev/null || true; nohup python3 ${workingDir}/main.py > /tmp/${projectId}.log 2>&1 &`;
                            }
                            if (!buildCmd)
                                buildCmd = detectedBuild;
                            if (!deployCmd)
                                deployCmd = detectedDeploy;
                        }
                    }
                    // Parse jira keys into Postgres array literal
                    const jiraKeysArr = jiraKeysStr
                        ? `{${jiraKeysStr.split(",").map((k) => k.trim()).filter(Boolean).join(",")}}`
                        : null;
                    try {
                        await withDbClient(dbUrl, async (client) => {
                            await client.query(`INSERT INTO projects (project_id, display_name, description, working_dir, default_container, build_cmd, deploy_cmd, smoke_url, jira_issue_keys, confluence_root_id, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, now(), now())
                 ON CONFLICT (project_id) DO UPDATE SET
                   display_name = COALESCE(EXCLUDED.display_name, projects.display_name),
                   description = COALESCE(EXCLUDED.description, projects.description),
                   working_dir = COALESCE(EXCLUDED.working_dir, projects.working_dir),
                   default_container = COALESCE(EXCLUDED.default_container, projects.default_container),
                   build_cmd = COALESCE(EXCLUDED.build_cmd, projects.build_cmd),
                   deploy_cmd = COALESCE(EXCLUDED.deploy_cmd, projects.deploy_cmd),
                   smoke_url = COALESCE(EXCLUDED.smoke_url, projects.smoke_url),
                   jira_issue_keys = COALESCE(EXCLUDED.jira_issue_keys, projects.jira_issue_keys),
                   confluence_root_id = COALESCE(EXCLUDED.confluence_root_id, projects.confluence_root_id),
                   updated_at = now()`, [projectId, display_name || null, projDescription || null, workingDir, default_container || null, buildCmd, deployCmd, inputSmokeUrl || null, jiraKeysArr, confluence_root_id || null]);
                        });
                        // Read back the full row to return
                        const row = await withDbClient(dbUrl, async (client) => {
                            const r = await client.query(`SELECT project_id, display_name, description, working_dir, default_container, build_cmd, deploy_cmd, smoke_url, jira_issue_keys, confluence_root_id, created_at, updated_at FROM projects WHERE project_id = $1`, [projectId]);
                            return r.rows[0] ?? null;
                        });
                        return { content: [{ type: "text", text: JSON.stringify({ ok: true, project: row }) }] };
                    }
                    catch (err) {
                        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
                    }
                }
                case "bootstrap_session": {
                    const { user_request, user_id, project_hint } = args;
                    const result = await bootstrapSession({ user_request, user_id, project_hint });
                    return { content: [{ type: "text", text: JSON.stringify(result) }] };
                }
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        }
        catch (err) {
            return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
        }
    });
    return server;
}
// ─── SSE Transport (legacy) ────────────────────────────────────────────────
const transports = new Map();
app.get("/sse", async (req, res) => {
    const transport = new sse_js_1.SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => transports.delete(transport.sessionId));
    const server = createMcpServer();
    await server.connect(transport);
});
app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
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
// CLI uses: curl -X POST http://localhost:9000/session/:id/message -d '{"role":"coding_agent","message_type":"approval_request","content":"..."}'
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
            const insertRes = await client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, metadata, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, now())
         RETURNING message_id, created_at`, [sessionId, role, content, message_type, metadataJson]);
            const inserted = insertRes.rows[0];
            if (inserted) {
                const notifyPayload = JSON.stringify({
                    id: inserted.message_id,
                    message_id: inserted.message_id,
                    session_id: sessionId,
                    role,
                    message_type,
                    content,
                    created_at: inserted.created_at,
                });
                const safeId = sessionId.replace(/-/g, "_");
                await client.query("SELECT pg_notify($1, $2)", [`session_messages_${safeId}`, notifyPayload]).catch(() => { });
                await client.query("SELECT pg_notify($1, $2)", [`session_messages`, notifyPayload]).catch(() => { });
                await client.query("SELECT pg_notify($1, $2)", [`session:${sessionId}`, notifyPayload]).catch(() => { });
            }
            return inserted;
        });
        res.json({ ok: true, message_id: row?.message_id });
    }
    catch (e) {
        console.error(`[/session/:id/message] Error: ${e.message}`);
        res.status(500).json({ ok: false, error: e.message });
    }
});
// ─── Background LISTEN chain (ZI-18776) ───────────────────────────────────
// Active reconnect-safe Postgres LISTEN: task_brief insert → spawn dev-lead via gateway.
// Replaces the passive instrumentation.ts chain that had zero reconnect logic.
async function startListenChain() {
    const dbUrl = process.env.OPS_DB_URL;
    if (!dbUrl) {
        console.warn("[listen-chain] OPS_DB_URL not set — background LISTEN chain disabled");
        return;
    }
    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://172.17.0.1:18789";
    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
    const listenClient = new pg_1.Client({ connectionString: dbUrl });
    try {
        await listenClient.connect();
        await listenClient.query("LISTEN session_messages");
        await listenClient.query("LISTEN session_events");
        console.log("[listen-chain] Postgres LISTEN session_messages + session_events started");
        listenClient.on("notification", (msg) => {
            void (async () => {
                try {
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
                    // Checkpoint from coding_agent triggers dev-lead close-out
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
                                    console.log(`[listen-chain] approval_request ${approvalMsgId} for ${sessionId} is hard — no auto-approve`);
                                    return;
                                }
                                const deadline = new Date(created_at).getTime() + 600_000;
                                const remaining = Math.max(0, deadline - Date.now());
                                console.log(`[listen-chain] approval_request ${approvalMsgId} for ${sessionId} (${complexity}) — auto-approve in ${Math.round(remaining / 1000)}s`);
                                setTimeout(async () => {
                                    try {
                                        const autoClient = new pg_1.Client({ connectionString: dbUrl });
                                        await autoClient.connect();
                                        const existingRes = await autoClient.query(`SELECT 1 FROM session_messages
                       WHERE session_id = $1 AND message_type = 'approval_response'
                         AND created_at > (SELECT created_at FROM session_messages WHERE message_id = $2)
                       LIMIT 1`, [sessionId, approvalMsgId]);
                                        if (existingRes.rows.length > 0) {
                                            await autoClient.end().catch(() => { });
                                            console.log(`[listen-chain] auto-approve skipped for ${sessionId} — already approved`);
                                            return;
                                        }
                                        const autoMsgId = `msg-${(0, crypto_1.randomUUID)()}`;
                                        const nowIso = new Date().toISOString();
                                        await autoClient.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
                       VALUES ($1, $2, 'system', 'auto-approved', 'approval_response', NOW())`, [autoMsgId, sessionId]);
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
                                        console.log(`[listen-chain] server auto-approved session ${sessionId} (msg ${autoMsgId})`);
                                    }
                                    catch (err) {
                                        console.error("[listen-chain] auto-approve error:", err.message);
                                    }
                                }, remaining);
                            }
                            catch (err) {
                                console.error("[listen-chain] approval_request handling error:", err.message);
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
                                console.log(`[listen-chain] skip for interactive session ${sessionId}`);
                                return;
                            }
                            if (isApprovalResponse && session.status !== "active") {
                                console.log(`[listen-chain] skip approval wake for non-active session ${sessionId} (${session.status})`);
                                return;
                            }
                        }
                    }
                    catch (e) {
                        console.warn(`[listen-chain] session check error for ${sessionId}:`, e.message);
                    }
                    // ── approval_response → EXECUTION code_task ───────────────────
                    if (isApprovalResponse) {
                        console.log(`[listen-chain] approval_response for ${sessionId} — spawning EXECUTION code task`);
                        try {
                            const { instruction, workingDir, resumeClaudeSessionId } = await buildExecutionInstruction(sessionId, dbUrl);
                            spawnCodeTask({ instruction, workingDir, sessionId, dbUrl, resumeClaudeSessionId });
                            console.log(`[listen-chain] EXECUTION code task spawned for ${sessionId}`);
                        }
                        catch (e) {
                            console.error(`[listen-chain] EXECUTION spawn error for ${sessionId}:`, e.message);
                        }
                        return;
                    }
                    // ── checkpoint (coding_agent) → dev-lead close-out ────────────
                    if (isCheckpoint) {
                        console.log(`[listen-chain] checkpoint from coding_agent for ${sessionId} — spawning dev-lead close-out`);
                        const checkpointContent = payload.content ?? "(no checkpoint content)";
                        try {
                            const task = await buildCloseoutMessage(sessionId, checkpointContent, dbUrl);
                            const resp = await fetch(`${gatewayUrl}/tools/invoke`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${gatewayToken}` },
                                body: JSON.stringify({
                                    tool: "sessions_spawn",
                                    args: { agentId: "dev-lead", task, cwd: "/home/openclaw/agents/dev-lead" },
                                }),
                            });
                            if (resp.ok) {
                                const parsed = await resp.json().catch(() => ({}));
                                console.log(`[listen-chain] dev-lead close-out spawned for ${sessionId}, key=${parsed?.childSessionKey ?? "n/a"}`);
                            }
                            else {
                                const text = await resp.text().catch(() => "");
                                console.warn(`[listen-chain] dev-lead spawn failed for ${sessionId}: ${resp.status} ${text.slice(0, 200)}`);
                            }
                        }
                        catch (e) {
                            console.error(`[listen-chain] close-out spawn error for ${sessionId}:`, e.message);
                        }
                        return;
                    }
                    // ── chat → dev-lead (interactive help) ───────────────────────
                    if (isChatMessage) {
                        console.log(`[listen-chain] chat for ${sessionId} — spawning dev-lead`);
                        try {
                            const resp = await fetch(`${gatewayUrl}/tools/invoke`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${gatewayToken}` },
                                body: JSON.stringify({
                                    tool: "sessions_spawn",
                                    args: { agentId: "dev-lead", task: await buildSpawnMessage(sessionId, dbUrl), cwd: "/home/openclaw/agents/dev-lead" },
                                }),
                            });
                            if (resp.ok) {
                                const parsed = await resp.json().catch(() => ({}));
                                console.log(`[listen-chain] dev-lead spawned for chat ${sessionId}, key=${parsed?.childSessionKey ?? "n/a"}`);
                            }
                            else {
                                const text = await resp.text().catch(() => "");
                                console.warn(`[listen-chain] dev-lead chat spawn failed for ${sessionId}: ${resp.status} ${text.slice(0, 200)}`);
                            }
                        }
                        catch (e) {
                            console.error(`[listen-chain] chat spawn error for ${sessionId}:`, e.message);
                        }
                    }
                }
                catch (err) {
                    console.error("[listen-chain] notification handler error:", err.message);
                }
            })();
        });
        listenClient.on("error", (err) => {
            console.error("[listen-chain] Postgres LISTEN client error:", err.message);
            // Reconnect after 10s (fixes the zero-reconnect failure mode)
            setTimeout(() => { void startListenChain(); }, 10_000);
        });
    }
    catch (err) {
        console.error("[listen-chain] failed to start LISTEN:", err.message);
        setTimeout(() => { void startListenChain(); }, 10_000);
        return;
    }
    // Backfill: find stuck pending sessions (no approval_request yet) → spawn BOOTSTRAP
    void (async () => {
        const backfillClient = new pg_1.Client({ connectionString: dbUrl });
        try {
            await backfillClient.connect();
            const res = await backfillClient.query(`SELECT DISTINCT s.session_id
         FROM sessions s
         JOIN session_messages sm ON sm.session_id = s.session_id
         WHERE s.status = 'pending'
           AND sm.message_type = 'task_brief'
           AND sm.role = 'user'
           AND s.session_type != 'interactive'
           AND NOT EXISTS (
             SELECT 1 FROM session_messages sm2
             WHERE sm2.session_id = s.session_id
               AND sm2.role IN ('coding_agent', 'assistant')
           )
         ORDER BY s.session_id`);
            if (res.rows.length > 0) {
                console.log(`[listen-chain] backfill: ${res.rows.length} pending session(s) found — spawning BOOTSTRAP`);
                for (const row of res.rows) {
                    try {
                        const { instruction, workingDir, allowedTools } = await buildBootstrapInstruction(row.session_id, dbUrl);
                        spawnCodeTask({ instruction, workingDir, sessionId: row.session_id, dbUrl, allowedTools });
                        console.log(`[listen-chain] backfill BOOTSTRAP spawned for ${row.session_id}`);
                    }
                    catch (e) {
                        console.error(`[listen-chain] backfill error for ${row.session_id}:`, e.message);
                    }
                }
            }
        }
        catch (err) {
            console.error("[listen-chain] backfill error:", err.message);
        }
        finally {
            await backfillClient.end().catch(() => { });
        }
    })();
}
// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "9000", 10);
const server = app.listen(PORT, () => {
    console.log(`container-mcp v2.2.0 running on port ${PORT}`);
    console.log(`  SSE:    http://localhost:${PORT}/sse`);
    console.log(`  Health: http://localhost:${PORT}/health`);
});
server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error(`[container-mcp] Port ${PORT} still in use - retrying in 5s`);
        setTimeout(() => { server.listen(PORT); }, 5000);
    }
    else {
        console.error(`[container-mcp] Server error: ${err.message}`);
    }
});
void startListenChain();
