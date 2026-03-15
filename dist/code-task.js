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
function spawnCodeTask(params) {
    const { instruction, workingDir, sessionId, dbUrl, maxTurns = 40, budgetUsd = 8.0, timeoutSeconds = 1200, model, effort, agents, allowedTools, resumeClaudeSessionId, taskRules, } = params;
    const taskId = (0, crypto_1.randomUUID)();
    task_logs_js_1.taskLogs.set(taskId, []);
    const log = (line) => task_logs_js_1.taskLogs.get(taskId).push(line);
    const debugLogPath = `/tmp/task-${taskId}-debug.log`;
    (0, feed_js_1.postToFeed)(sessionId, dbUrl, `🚀 Starting code task (${taskId})${model ? ` [${model}]` : ""}${resumeClaudeSessionId ? " [resumed]" : ""}\n\n${instruction.slice(0, 400)}`);
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
            proc.on("error", (err) => {
                clearTimeout(timer);
                try {
                    fs.unlinkSync(rulesFile);
                }
                catch { }
                const msg = `spawn claude failed: ${err.message}`;
                console.error(`[spawnCodeTask] spawn error for task ${taskId}: ${msg}`);
                (0, feed_js_1.postToFeed)(sessionId, dbUrl, `Task ${taskId} spawn error: ${msg}`);
                if (sessionId && dbUrl) {
                    void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                        await client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
               VALUES (gen_random_uuid(), $1, 'system', $2, 'console', now())`, [sessionId, `Backfill BOOTSTRAP failed (spawn error): ${msg}`]);
                    }).catch(() => { });
                }
            });
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
                                void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                    await client.query(`UPDATE sessions SET claude_session_id = $1, updated_at = now() WHERE session_id = $2`, [claudeSessionId, sessionId]).catch(() => { });
                                });
                            }
                            const output = (parsed.result || parsed.output || "");
                            (0, feed_js_1.postToFeed)(sessionId, dbUrl, `✅ Task complete\n\n${output.slice(0, 4000)}`);
                            const usage = parsed.usage;
                            if (usage && sessionId && dbUrl) {
                                const inputTokens = usage.input_tokens || 0;
                                const outputTokens = usage.output_tokens || 0;
                                const costUsd = (inputTokens / 1_000_000 * 3) + (outputTokens / 1_000_000 * 15);
                                void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                    await client.query(`UPDATE sessions SET token_usage = COALESCE(token_usage, 0) + $1, cost_usd = COALESCE(cost_usd, 0) + $2 WHERE session_id = $3`, [inputTokens + outputTokens, costUsd, sessionId]);
                                }).catch((err) => console.error("[token-usage] Failed:", err));
                            }
                        }
                        else if (parsed.type === "assistant") {
                            for (const block of (parsed.message?.content || [])) {
                                if (block.type === "tool_use") {
                                    (0, feed_js_1.postToFeed)(sessionId, dbUrl, `🔧 \`${block.name}\` ${JSON.stringify(block.input || {}).slice(0, 500)}`);
                                }
                                else if (block.type === "text" && block.text?.trim() && !parsed.message?.usage) {
                                    const text = block.text.trim().slice(0, 1000);
                                    if (text.length > 20)
                                        (0, feed_js_1.postToFeed)(sessionId, dbUrl, `💭 ${text}`);
                                }
                            }
                        }
                        else if (parsed.type === "tool_result") {
                            const resultText = (parsed.content?.[0]?.text || "").slice(0, 2000);
                            if (resultText)
                                (0, feed_js_1.postToFeed)(sessionId, dbUrl, `📄 Result: ${resultText}`);
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
                    (0, feed_js_1.postToFeed)(sessionId, dbUrl, `⚠️ stderr: ${text.slice(0, 500)}`, "system", "console");
                }
            });
            proc.on("close", (code) => {
                clearTimeout(timer);
                try {
                    fs.unlinkSync(rulesFile);
                }
                catch { }
                (0, feed_js_1.postToFeed)(sessionId, dbUrl, `✅ Process ${taskId} exited with code ${code}. Debug log: ${debugLogPath}`);
                console.log(`[spawnCodeTask] task ${taskId} done (code ${code}), debug log at ${debugLogPath}`);
            });
        }
        catch (err) {
            console.error(`[spawnCodeTask] Error: ${err.message}`);
            (0, feed_js_1.postToFeed)(sessionId, dbUrl, `❌ Task ${taskId} failed to start: ${err.message}`);
        }
    })().catch((err) => console.error(`[spawnCodeTask] Unhandled rejection: ${err.message}`));
    return taskId;
}
