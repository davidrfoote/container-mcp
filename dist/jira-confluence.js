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
exports.httpGet = httpGet;
exports.httpPost = httpPost;
exports.jiraAuthHeaders = jiraAuthHeaders;
exports.fetchJiraIssue = fetchJiraIssue;
exports.logCacheWarning = logCacheWarning;
exports.fetchConfluencePage = fetchConfluencePage;
exports.stripHtml = stripHtml;
exports.writeCacheEntry = writeCacheEntry;
exports.populateCacheForProject = populateCacheForProject;
exports.searchJiraForIssue = searchJiraForIssue;
exports.createJiraTaskIssue = createJiraTaskIssue;
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const db_js_1 = require("./db.js");
// ─── HTTP helpers ──────────────────────────────────────────────────────────
function logHttpError(msg) {
    const dbUrl = process.env.OPS_DB_URL;
    if (!dbUrl)
        return;
    (0, db_js_1.withDbClient)(dbUrl, (client) => client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
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
// ─── Jira auth ─────────────────────────────────────────────────────────────
let _jiraAuthHeadersCache = null;
async function jiraAuthHeaders() {
    if (_jiraAuthHeadersCache)
        return _jiraAuthHeadersCache;
    try {
        const dbUrl = process.env.OPS_DB_URL;
        const token = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
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
// ─── Jira/Confluence fetch ─────────────────────────────────────────────────
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
        await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
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
// ─── Cache helpers ─────────────────────────────────────────────────────────
async function writeCacheEntry(dbUrl, cacheKey, sourceType, contentHash, sourceUpdated, summary) {
    console.log(`[writeCacheEntry] Writing cache_key=${cacheKey}, source_type=${sourceType}`);
    try {
        await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
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
