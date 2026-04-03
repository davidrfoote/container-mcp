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
exports.spawnCodeTask = spawnCodeTask;
const crypto_1 = require("crypto");
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const db_js_1 = require("./db.js");
const feed_js_1 = require("./feed.js");
const task_logs_js_1 = require("./task-logs.js");
const model_registry_js_1 = require("./model-registry.js");
function spawnCodeTask(params) {
    const { instruction, workingDir, sessionId, dbUrl, maxTurns = 40, budgetUsd = 8.0, timeoutSeconds = 1200, model, effort, agents, allowedTools, resumeClaudeSessionId, taskRules, } = params;
    const taskId = (0, crypto_1.randomUUID)();
    task_logs_js_1.taskLogs.set(taskId, []);
    const log = (line) => task_logs_js_1.taskLogs.get(taskId).push(line);
    const debugLogPath = `/tmp/task-${taskId}-debug.log`;
    const resolvedModel = model || model_registry_js_1.DEFAULT_MODEL;
    (0, feed_js_1.postToFeed)(sessionId, dbUrl, `🚀 Starting code task (${taskId}) [${resolvedModel}]${resumeClaudeSessionId ? " [resumed]" : ""}\n\n${instruction.slice(0, 400)}`);
    // Emit structured cli_context so the session view can show full agent visibility
    if (sessionId && dbUrl) {
        // Read rules files now so we can surface them in the UI before the process starts
        let rulesPreview = "";
        try {
            rulesPreview += fs.readFileSync("/home/david/.rules/base.md", "utf8");
        }
        catch { }
        try {
            rulesPreview += "\n" + fs.readFileSync(path.join(workingDir, ".rules/project.md"), "utf8");
        }
        catch { }
        if (taskRules)
            rulesPreview += "\n" + taskRules;
        void (0, feed_js_1.postToFeed)(sessionId, dbUrl, JSON.stringify({
            kind: "task_start",
            taskId,
            model: model || model_registry_js_1.DEFAULT_MODEL,
            effort: effort ?? null,
            allowedTools: allowedTools ?? [],
            agents: agents ? (() => { try {
                return JSON.parse(agents);
            }
            catch {
                return agents;
            } })() : null,
            isResumed: !!resumeClaudeSessionId,
            workingDir,
            rules: rulesPreview.trim().slice(0, 4000),
        }), "system", "cli_context");
    }
    // Persist the active task ID so dev-session-app can detect in-flight tasks on restart
    if (sessionId && dbUrl) {
        void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
            await client.query(`UPDATE sessions SET active_task_id = $1, task_started_at = now(), updated_at = now() WHERE session_id = $2`, [taskId, sessionId]);
        }).catch((err) => console.error(`[spawnCodeTask] failed to set active_task_id: ${err.message}`));
    }
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
            // Write MCP config so the CLI agent can query gitnexus at runtime
            const mcpConfigPath = `/tmp/mcp-config-${taskId}.json`;
            const mcpConfig = {};
            if (process.env.GITNEXUS_SERVICE_URL) {
                mcpConfig["gitnexus"] = {
                    type: "sse",
                    url: `${process.env.GITNEXUS_SERVICE_URL.replace(/\/$/, "")}/sse`,
                };
            }
            const hasMcpConfig = Object.keys(mcpConfig).length > 0;
            if (hasMcpConfig) {
                fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: mcpConfig }, null, 2));
            }
            const claudeArgs = [
                "-p", instruction,
                "--output-format", "stream-json",
                "--verbose",
                "--append-system-prompt-file", rulesFile,
                "--permission-mode", "acceptEdits",
                "--max-turns", String(maxTurns),
                "--max-budget-usd", String(budgetUsd),
                "--debug-file", debugLogPath,
            ];
            if (hasMcpConfig)
                claudeArgs.push("--mcp-config", mcpConfigPath);
            claudeArgs.push("--model", model || model_registry_js_1.DEFAULT_MODEL);
            if (effort)
                claudeArgs.push("--effort", effort);
            if (agents)
                claudeArgs.push("--agents", agents);
            if (allowedTools && allowedTools.length > 0)
                claudeArgs.push("--allowed-tools", allowedTools.join(","));
            if (resumeClaudeSessionId)
                claudeArgs.push("--resume", resumeClaudeSessionId);
            const proc = (0, child_process_1.spawn)("claude", claudeArgs, {
                cwd: workingDir, env: { ...process.env, PATH: `/home/openclaw/.npm-global/bin:/usr/local/bin:/usr/bin:/home/david/.npm-local/bin:${process.env.PATH ?? ""}`, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined }, stdio: ["ignore", "pipe", "pipe"],
            });
            const timer = setTimeout(() => { proc.kill("SIGTERM"); }, timeoutSeconds * 1000);
            proc.on("error", (err) => {
                clearTimeout(timer);
                try {
                    fs.unlinkSync(rulesFile);
                }
                catch { }
                if (hasMcpConfig)
                    try {
                        fs.unlinkSync(mcpConfigPath);
                    }
                    catch { }
                const msg = `spawn claude failed: ${err.message}`;
                console.error(`[spawnCodeTask] spawn error for task ${taskId}: ${msg}`);
                (0, feed_js_1.postToFeed)(sessionId, dbUrl, `Task ${taskId} spawn error: ${msg}`);
                // Clear the in-flight task marker on error
                if (sessionId && dbUrl) {
                    void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                        await client.query(`UPDATE sessions SET active_task_id = NULL, task_started_at = NULL, updated_at = now()
               WHERE session_id = $1 AND active_task_id = $2`, [sessionId, taskId]);
                    }).catch(() => { });
                }
                if (sessionId && dbUrl) {
                    void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                        await client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
               VALUES (gen_random_uuid(), $1, 'system', $2, 'console', now())`, [sessionId, `Backfill BOOTSTRAP failed (spawn error): ${msg}`]);
                    }).catch(() => { });
                }
            });
            // Accumulate stdout across chunks — JSON lines may span chunk boundaries
            let stdoutBuf = "";
            proc.stdout.on("data", (chunk) => {
                stdoutBuf += chunk.toString();
                const lines = stdoutBuf.split("\n");
                // Keep the last (potentially incomplete) line in the buffer
                stdoutBuf = lines.pop() ?? "";
                for (const line of lines) {
                    if (!line.trim())
                        continue;
                    log(line);
                    try {
                        const parsed = JSON.parse(line);
                        const evType = parsed.type;
                        // ── system init: model, version, tools, MCP servers ──────────────
                        if (evType === "system" && parsed.subtype === "init") {
                            const cliModel = parsed.model;
                            const version = parsed.claude_code_version;
                            const permMode = parsed.permissionMode;
                            // mcp_servers may be an array of objects {name, status, ...} or plain strings
                            const mcpServersRaw = parsed.mcp_servers ?? [];
                            const mcpServers = mcpServersRaw.map((s) => typeof s === "string" ? s : (s.name ?? s.id ?? String(s)));
                            const tools = parsed.tools ?? [];
                            // Persist model name into sessions table, then push a session_update
                            // notification so the browser header badge refreshes immediately
                            // (without waiting for the 15s polling refetch).
                            if (cliModel && sessionId && dbUrl) {
                                const safeSessionId = sessionId.replace(/-/g, "_");
                                void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                    // Write to both model (existing) and cli_model (new observability column)
                                    await client.query(`UPDATE sessions SET model = $1, cli_model = $1, updated_at = now() WHERE session_id = $2`, [cliModel, sessionId]);
                                    await client.query("SELECT pg_notify($1, $2)", [
                                        `session_status_${safeSessionId}`,
                                        JSON.stringify({ session_id: sessionId, model: cliModel }),
                                    ]);
                                }).catch((e) => console.error(`[spawnCodeTask] model write failed: ${e.message}`));
                            }
                            const mcpStr = mcpServers.length > 0 ? mcpServers.join(", ") : "none";
                            (0, feed_js_1.postToFeed)(sessionId, dbUrl, `⚙️ Claude Code v${version ?? "?"} · Model: ${cliModel ?? "?"} · Mode: ${permMode ?? "?"} · MCP: ${mcpStr} · ${tools.length} tools available`, "coding_agent", "console");
                            // Emit structured runtime info for full CLI visibility panel
                            void (0, feed_js_1.postToFeed)(sessionId, dbUrl, JSON.stringify({
                                kind: "runtime_init",
                                taskId,
                                model: cliModel ?? null,
                                version: version ?? null,
                                permissionMode: permMode ?? null,
                                mcpServers,
                                tools,
                            }), "system", "cli_context");
                            // ── assistant turn: tool calls and thinking text ─────────────────
                        }
                        else if (evType === "assistant") {
                            const content = parsed.message?.content ?? [];
                            for (const block of content) {
                                if (block.type === "tool_use") {
                                    const argsStr = JSON.stringify(block.input ?? {}).slice(0, 600);
                                    (0, feed_js_1.postToFeed)(sessionId, dbUrl, `🔧 \`${block.name}\` ${argsStr}`, "coding_agent", "execution_log");
                                    // Emit tool_active for live visibility of current tool
                                    void (0, feed_js_1.postToFeed)(sessionId, dbUrl, JSON.stringify({
                                        kind: "tool_active",
                                        taskId,
                                        toolName: block.name,
                                        toolId: block.id ?? null,
                                        inputSummary: JSON.stringify(block.input ?? {}).slice(0, 300),
                                    }), "system", "cli_context");
                                    // Detect subagent spawning (Task tool in Claude Code = spawning an agent)
                                    if (block.name === "Task") {
                                        void (0, feed_js_1.postToFeed)(sessionId, dbUrl, JSON.stringify({
                                            kind: "subagent_spawn",
                                            taskId,
                                            toolId: block.id ?? null,
                                            description: block.input?.description ?? "",
                                            prompt: (block.input?.prompt ?? "").slice(0, 500),
                                        }), "system", "cli_context");
                                    }
                                }
                                else if (block.type === "text" && block.text?.trim()) {
                                    const text = block.text.trim().slice(0, 1500);
                                    if (text.length > 20)
                                        (0, feed_js_1.postToFeed)(sessionId, dbUrl, `💭 ${text}`, "coding_agent", "execution_log");
                                }
                            }
                            // ── user turn: tool results (this is where they actually live) ───
                        }
                        else if (evType === "user") {
                            const content = parsed.message?.content ?? [];
                            for (const block of content) {
                                if (block.type === "tool_result") {
                                    const isError = block.is_error === true;
                                    const raw = block.content;
                                    const resultText = typeof raw === "string"
                                        ? raw
                                        : Array.isArray(raw)
                                            ? raw
                                                .filter(c => c.type === "text")
                                                .map(c => c.text ?? "")
                                                .join("")
                                            : "";
                                    const truncated = resultText.slice(0, 2000);
                                    if (truncated) {
                                        (0, feed_js_1.postToFeed)(sessionId, dbUrl, `${isError ? "❌" : "📄"} ${truncated}`, "coding_agent", "execution_log");
                                    }
                                }
                            }
                            // ── rate limit: surface blockages immediately ────────────────────
                        }
                        else if (evType === "rate_limit_event") {
                            const info = parsed.rate_limit_info;
                            if (info?.status === "blocked") {
                                const resetsAt = typeof info.resetsAt === "number"
                                    ? new Date(info.resetsAt * 1000).toISOString()
                                    : "unknown";
                                (0, feed_js_1.postToFeed)(sessionId, dbUrl, `⏸️ Rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "system", "console");
                            }
                            // ── result: final summary with accurate cost, turns, model usage ─
                        }
                        else if (evType === "result") {
                            const claudeSessionId = parsed.session_id;
                            const subtype = parsed.subtype ?? "success";
                            const isError = parsed.is_error === true;
                            const output = (parsed.result ?? parsed.output ?? "");
                            const totalCostUsd = parsed.total_cost_usd;
                            const numTurns = parsed.num_turns;
                            const durationMs = parsed.duration_ms;
                            const permDenials = parsed.permission_denials ?? [];
                            const modelUsage = parsed.modelUsage;
                            const usage = parsed.usage;
                            // Persist claude session ID for EXECUTION pass --resume
                            if (claudeSessionId && sessionId && dbUrl) {
                                void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                    await client.query(`UPDATE sessions SET claude_session_id = $1, updated_at = now() WHERE session_id = $2`, [claudeSessionId, sessionId]);
                                }).catch(() => { });
                            }
                            // Build human-readable summary line
                            const icon = isError ? "❌" : subtype === "interrupted" ? "⚠️" : subtype === "timeout" ? "⏱️" : "✅";
                            const parts = [`${icon} Task ${subtype}`];
                            if (durationMs !== undefined)
                                parts.push(`${(durationMs / 1000).toFixed(1)}s`);
                            if (numTurns !== undefined)
                                parts.push(`${numTurns} turn${numTurns !== 1 ? "s" : ""}`);
                            if (totalCostUsd !== undefined)
                                parts.push(`$${totalCostUsd.toFixed(4)}`);
                            // Per-model cost breakdown when multiple models were used
                            if (modelUsage) {
                                const breakdown = Object.entries(modelUsage)
                                    .map(([m, u]) => `${m}: $${(u.costUSD ?? 0).toFixed(4)}`)
                                    .join(", ");
                                if (breakdown)
                                    parts.push(`[${breakdown}]`);
                            }
                            let summary = parts.join(" · ");
                            if (permDenials.length > 0) {
                                summary += `\n⛔ Permission denials: ${permDenials.map(p => p.tool_name).join(", ")}`;
                            }
                            if (output)
                                summary += `\n\n${output.slice(0, 3000)}`;
                            (0, feed_js_1.postToFeed)(sessionId, dbUrl, summary);
                            // Update token usage and cost using accurate values from Claude
                            if (sessionId && dbUrl) {
                                const inputTokens = usage?.input_tokens ?? 0;
                                const outputTokens = usage?.output_tokens ?? 0;
                                const costToStore = totalCostUsd ?? ((inputTokens / 1_000_000 * 3) + (outputTokens / 1_000_000 * 15));
                                void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                    await client.query(`UPDATE sessions
                     SET token_usage = COALESCE(token_usage, 0) + $1,
                         cost_usd = COALESCE(cost_usd, 0) + $2,
                         num_turns = COALESCE(num_turns, 0) + $3,
                         task_duration_ms = COALESCE(task_duration_ms, 0) + $4,
                         updated_at = now()
                     WHERE session_id = $5`, [inputTokens + outputTokens, costToStore, numTurns ?? 0, durationMs ?? 0, sessionId]);
                                }).catch((err) => console.error("[token-usage] Failed:", err));
                            }
                        }
                    }
                    catch { }
                }
            });
            let stderrBuf = "";
            proc.stderr.on("data", (chunk) => {
                const text = chunk.toString();
                stderrBuf += text;
                log("[stderr] " + text);
                // Surface all stderr to the session feed — not just errors.
                // Warnings, deprecations, and diagnostics are all useful for debugging.
                // Debounce: flush when we see a newline to avoid posting char-by-char.
                const newlineIdx = stderrBuf.indexOf("\n");
                if (newlineIdx !== -1) {
                    const toPost = stderrBuf.slice(0, 2000).trim();
                    stderrBuf = "";
                    if (toPost)
                        (0, feed_js_1.postToFeed)(sessionId, dbUrl, `⚠️ stderr: ${toPost}`, "system", "console");
                }
            });
            proc.on("close", (code) => {
                clearTimeout(timer);
                try {
                    fs.unlinkSync(rulesFile);
                }
                catch { }
                if (hasMcpConfig)
                    try {
                        fs.unlinkSync(mcpConfigPath);
                    }
                    catch { }
                (0, feed_js_1.postToFeed)(sessionId, dbUrl, `✅ Process ${taskId} exited with code ${code}. Debug log: ${debugLogPath}`);
                console.log(`[spawnCodeTask] task ${taskId} done (code ${code}), debug log at ${debugLogPath}`);
                // Clear the in-flight task marker
                if (sessionId && dbUrl) {
                    void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                        await client.query(`UPDATE sessions SET active_task_id = NULL, task_started_at = NULL, updated_at = now()
               WHERE session_id = $1 AND active_task_id = $2`, [sessionId, taskId]);
                    }).catch((err) => console.error(`[spawnCodeTask] failed to clear active_task_id: ${err.message}`));
                }
            });
        }
        catch (err) {
            console.error(`[spawnCodeTask] Error: ${err.message}`);
            (0, feed_js_1.postToFeed)(sessionId, dbUrl, `❌ Task ${taskId} failed to start: ${err.message}`);
        }
    })().catch((err) => console.error(`[spawnCodeTask] Unhandled rejection: ${err.message}`));
    return taskId;
}
