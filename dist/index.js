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
const express_1 = __importDefault(require("express"));
const crypto_1 = require("crypto");
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const pg_1 = require("pg");
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Task log storage
const taskLogs = new Map();
// ─── postToFeed helper ─────────────────────────────────────────────────────
const _feedClients = new Map();
async function postToFeed(sessionId, dbUrl, content, role = "dev_lead", messageType = "execution_update") {
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
            await entry.client.query("INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4)", [sessionId, role, content, messageType]);
        }
        catch (e) {
            console.error("postToFeed error:", e.message);
        }
    });
}
// ─── MCP Server Factory ────────────────────────────────────────────────────
function createMcpServer() {
    const server = new index_js_1.Server({ name: "container-mcp", version: "2.0.0" }, { capabilities: { tools: {} } });
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
                        task_rules: { type: "string", description: "Extra rules to append" },
                        base_rules_path: { type: "string", default: "/home/david/.rules/base.md" },
                        project_rules_path: { type: "string", default: "/.rules/project.md" },
                        session_id: { type: "string", description: "ops-db session ID to post execution_update messages to" },
                        ops_db_url: { type: "string", description: "PostgreSQL connection URL (falls back to OPS_DB_URL env)" },
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
        ],
    }));
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        try {
            switch (name) {
                case "code_task": {
                    const { instruction, working_dir, driver = "claude", task_id, max_turns = 30, budget_usd = 5.0, timeout_seconds = 900, task_rules, base_rules_path = "/home/david/.rules/base.md", project_rules_path = "/.rules/project.md", session_id, ops_db_url, } = args;
                    const dbUrl = ops_db_url || process.env.OPS_DB_URL;
                    const taskId = task_id || (0, crypto_1.randomUUID)();
                    taskLogs.set(taskId, []);
                    const log = (line) => taskLogs.get(taskId).push(line);
                    postToFeed(session_id, dbUrl, `🚀 Starting \`code_task\` (driver: ${driver}, task_id: ${taskId})\n\nInstruction: ${instruction.slice(0, 300)}`);
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
                        const result = await new Promise((resolve) => {
                            const proc = (0, child_process_1.spawn)("claude", [
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
                            ], { cwd: working_dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
                                            output = parsed.result || parsed.output || JSON.stringify(parsed);
                                            postToFeed(session_id, dbUrl, `✅ Task complete\n\n${output.slice(0, 2000)}`);
                                        }
                                        else if (parsed.type === "assistant") {
                                            const content = parsed.message?.content || [];
                                            for (const block of content) {
                                                if (block.type === "tool_use") {
                                                    const toolName = block.name;
                                                    const toolInput = JSON.stringify(block.input || {}).slice(0, 200);
                                                    postToFeed(session_id, dbUrl, `🔧 \`${toolName}\` ${toolInput}`);
                                                }
                                                else if (block.type === "text" && block.text?.trim() && !parsed.message?.usage) {
                                                    const text = block.text.trim().slice(0, 500);
                                                    if (text.length > 20)
                                                        postToFeed(session_id, dbUrl, `💭 ${text}`);
                                                }
                                            }
                                        }
                                        else if (parsed.type === "tool_result") {
                                            const resultText = (parsed.content?.[0]?.text || "").slice(0, 300);
                                            if (resultText)
                                                postToFeed(session_id, dbUrl, `📄 Result: ${resultText}`);
                                        }
                                    }
                                    catch { }
                                }
                            });
                            proc.stderr.on("data", (chunk) => log("[stderr] " + chunk.toString()));
                            proc.on("close", (code) => {
                                clearTimeout(timer);
                                try {
                                    fs.unlinkSync(rulesFile);
                                }
                                catch { }
                                resolve({ success: code === 0, output, task_id: taskId, exit_code: code ?? -1 });
                            });
                        });
                        return { content: [{ type: "text", text: JSON.stringify(result) }] };
                    }
                    else {
                        // cline driver
                        const clinerules = path.join(working_dir, ".clinerules");
                        fs.writeFileSync(clinerules, rules);
                        const result = await new Promise((resolve) => {
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
                                resolve({ success: code === 0, output: outputLines.join("\n"), task_id: taskId, exit_code: code ?? -1 });
                            });
                        });
                        return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
                case "chat_session": {
                    const { message, session_id: chatSessionId, claude_session_id: existingClaudeSessionId, working_dir: chatWorkingDir = "/home/david/dev-session-app", } = args;
                    const dbUrl = process.env.OPS_DB_URL ?? "";
                    // Note: user message is already saved by the dev-session-app chat route.
                    // No need to echo it again here.
                    if (chatSessionId && dbUrl && false) { // disabled - prevents duplicate user messages
                    }
                    const claudeArgs = [
                        "-p", message,
                        "--output-format", "stream-json",
                        "--verbose",
                        "--dangerously-skip-permissions",
                    ];
                    if (existingClaudeSessionId) {
                        claudeArgs.push("--resume", existingClaudeSessionId);
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
                                                                await entry.client.query("INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4)", [chatSessionId, "coding_agent", text, "execution_log"]);
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
                                            tokensUsed = (parsed.usage.input_tokens || 0) + (parsed.usage.output_tokens || 0);
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
                                            await entry.client.query("INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4)", [chatSessionId, "coding_agent", fullAssistantText.trim(), "chat"]);
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
                    // POST to gateway /v1/chat/completions to spawn dev-lead (OpenClaw 3.8+)
                    const { session_id: sessionId } = args;
                    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://172.17.0.1:18789";
                    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 15_000);
                    try {
                        const resp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Authorization": `Bearer ${gatewayToken}`,
                            },
                            body: JSON.stringify({
                                model: "openclaw:dev-lead",
                                messages: [{ role: "user", content: `SESSION_ID: ${sessionId}` }],
                                stream: false,
                            }),
                            signal: controller.signal,
                        });
                        clearTimeout(timeout);
                        if (!resp.ok) {
                            const text = await resp.text();
                            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Gateway ${resp.status}: ${text}` }) }] };
                        }
                        return { content: [{ type: "text", text: JSON.stringify({ ok: true, session_id: sessionId }) }] };
                    }
                    catch (fetchErr) {
                        clearTimeout(timeout);
                        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: fetchErr.message }) }] };
                    }
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
    res.json({ status: "ok", server: "container-mcp", version: "2.0.0" });
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
        console.log("[listen-chain] Postgres LISTEN session_messages started");
        listenClient.on("notification", (msg) => {
            void (async () => {
                try {
                    if (!msg.payload)
                        return;
                    const payload = JSON.parse(msg.payload);
                    if (payload.message_type !== "task_brief" || payload.role !== "user")
                        return;
                    const sessionId = payload.session_id;
                    if (!sessionId)
                        return;
                    // Skip interactive sessions — they use chat_session directly, not dev-lead
                    try {
                        const checkClient = new pg_1.Client({ connectionString: dbUrl });
                        await checkClient.connect();
                        const checkRes = await checkClient.query("SELECT session_type FROM sessions WHERE session_id = $1", [sessionId]);
                        await checkClient.end().catch(() => { });
                        if (checkRes.rows.length > 0 && checkRes.rows[0].session_type === "interactive") {
                            console.log(`[listen-chain] skip dev-lead for interactive session ${sessionId}`);
                            return;
                        }
                    }
                    catch (e) {
                        console.warn(`[listen-chain] session_type check error for ${sessionId}:`, e.message);
                    }
                    console.log(`[listen-chain] task_brief for ${sessionId} — spawning dev-lead via gateway`);
                    const resp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${gatewayToken}`,
                        },
                        body: JSON.stringify({
                            model: "openclaw:dev-lead",
                            messages: [{ role: "user", content: `SESSION_ID: ${sessionId}` }],
                            stream: false,
                        }),
                        signal: AbortSignal.timeout(15_000),
                    });
                    if (resp.ok) {
                        console.log(`[listen-chain] dev-lead spawned for ${sessionId}`);
                    }
                    else {
                        const text = await resp.text().catch(() => "");
                        console.warn(`[listen-chain] gateway spawn failed for ${sessionId}: ${resp.status} ${text.slice(0, 200)}`);
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
    // Backfill: find stuck pending sessions on startup
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
           AND NOT EXISTS (
             SELECT 1 FROM session_messages sm2
             WHERE sm2.session_id = s.session_id AND sm2.role = 'assistant'
           )
         ORDER BY s.session_id`);
            if (res.rows.length > 0) {
                console.log(`[listen-chain] backfill: ${res.rows.length} pending session(s) found`);
                for (const row of res.rows) {
                    try {
                        const resp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Authorization": `Bearer ${gatewayToken}`,
                            },
                            body: JSON.stringify({
                                model: "openclaw:dev-lead",
                                messages: [{ role: "user", content: `SESSION_ID: ${row.session_id}` }],
                                stream: false,
                            }),
                            signal: AbortSignal.timeout(15_000),
                        });
                        console.log(`[listen-chain] backfill ${row.session_id}: ${resp.ok ? "spawned" : `failed (${resp.status})`}`);
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
app.listen(PORT, () => {
    console.log(`container-mcp v2.1.0 running on port ${PORT}`);
    console.log(`  SSE:    http://localhost:${PORT}/sse`);
    console.log(`  Health: http://localhost:${PORT}/health`);
});
void startListenChain();
