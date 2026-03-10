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
const cliSessions = new Map();
// ─── postToFeed helper ─────────────────────────────────────────────────────
const _feedClients = new Map();
async function postToFeed(sessionId, dbUrl, content, messageType = "execution_update", role = "dev_lead") {
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
                name: "start_session",
                description: "Start a long-running Claude CLI session (ZI-18753/18754). Non-blocking — returns immediately, streams output to ops-db.",
                inputSchema: {
                    type: "object",
                    properties: {
                        job_id: { type: "string", description: "Unique ID for this session" },
                        instruction: { type: "string", description: "Task instruction for Claude" },
                        working_dir: { type: "string", description: "Working directory" },
                        session_id: { type: "string", description: "ops-db session ID to stream messages to" },
                        ops_db_url: { type: "string", description: "PostgreSQL connection URL (falls back to OPS_DB_URL env)" },
                        base_rules_path: { type: "string", default: "/home/david/.rules/base.md" },
                        project_rules_path: { type: "string", default: "/.rules/project.md" },
                        max_turns: { type: "number", default: 30 },
                        budget_usd: { type: "number", default: 5.0 },
                    },
                    required: ["job_id", "instruction", "working_dir"],
                },
            },
            {
                name: "pause_session",
                description: "Pause a running CLI session (SIGSTOP)",
                inputSchema: {
                    type: "object",
                    properties: { job_id: { type: "string" } },
                    required: ["job_id"],
                },
            },
            {
                name: "resume_session",
                description: "Resume a paused CLI session (SIGCONT)",
                inputSchema: {
                    type: "object",
                    properties: { job_id: { type: "string" } },
                    required: ["job_id"],
                },
            },
            {
                name: "cancel_session",
                description: "Cancel a running CLI session (SIGTERM)",
                inputSchema: {
                    type: "object",
                    properties: { job_id: { type: "string" } },
                    required: ["job_id"],
                },
            },
            {
                name: "get_session_status",
                description: "Get status, token usage, and context window % of a CLI session",
                inputSchema: {
                    type: "object",
                    properties: { job_id: { type: "string" } },
                    required: ["job_id"],
                },
            },
            {
                name: "send_message",
                description: "Send a user message into a running CLI session via stdin (ZI-18755)",
                inputSchema: {
                    type: "object",
                    properties: {
                        job_id: { type: "string" },
                        message: { type: "string" },
                    },
                    required: ["job_id", "message"],
                },
            },
            {
                name: "list_sessions",
                description: "List all active CLI sessions",
                inputSchema: { type: "object", properties: {} },
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
                case "start_session": {
                    // ZI-18753, ZI-18754: Start a long-running Claude CLI session
                    const { job_id, instruction, working_dir, session_id, ops_db_url, base_rules_path = "/home/david/.rules/base.md", project_rules_path = "/.rules/project.md", max_turns = 30, budget_usd = 5.0, } = args;
                    if (cliSessions.has(job_id)) {
                        return { content: [{ type: "text", text: JSON.stringify({ error: `Session ${job_id} already exists` }) }], isError: true };
                    }
                    const dbUrl = ops_db_url || process.env.OPS_DB_URL;
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
                    const rulesFile = `/tmp/cli-session-rules-${job_id}.md`;
                    if (rules)
                        fs.writeFileSync(rulesFile, rules);
                    const claudeArgs = [
                        "-p", instruction,
                        "--output-format", "stream-json",
                        "--input-format", "stream-json",
                        "--verbose",
                        "--include-partial-messages",
                        "--permission-mode", "acceptEdits",
                        "--max-turns", String(max_turns),
                        "--max-budget-usd", String(budget_usd),
                        "--dangerously-skip-permissions",
                    ];
                    if (rules)
                        claudeArgs.push("--append-system-prompt-file", rulesFile);
                    const proc = (0, child_process_1.spawn)("claude", claudeArgs, {
                        cwd: working_dir,
                        env: process.env,
                        stdio: ["pipe", "pipe", "pipe"],
                    });
                    const session = {
                        proc,
                        sessionId: session_id || "",
                        opsDbUrl: dbUrl || "",
                        workingDir: working_dir,
                        startedAt: new Date(),
                        lastActivity: new Date(),
                        status: "running",
                        tokenInput: 0,
                        tokenOutput: 0,
                        tokenCache: 0,
                        model: "claude",
                        contextPct: 0,
                    };
                    cliSessions.set(job_id, session);
                    // ZI-18754: Wire stdout listener — parse stream-json, post to ops-db
                    proc.stdout?.on("data", (chunk) => {
                        const lines = chunk.toString().split("\n");
                        for (const line of lines) {
                            if (!line.trim())
                                continue;
                            session.lastActivity = new Date();
                            try {
                                const evt = JSON.parse(line);
                                // Accumulate token usage from any event
                                const usage = evt.usage || evt.message?.usage;
                                if (usage) {
                                    if (usage.input_tokens)
                                        session.tokenInput += usage.input_tokens;
                                    if (usage.output_tokens)
                                        session.tokenOutput += usage.output_tokens;
                                    if (usage.cache_read_input_tokens)
                                        session.tokenCache += usage.cache_read_input_tokens;
                                    if (usage.cache_creation_input_tokens)
                                        session.tokenCache += usage.cache_creation_input_tokens;
                                }
                                // Model name
                                if (evt.message?.model)
                                    session.model = evt.message.model;
                                if (evt.type === "system" && evt.subtype === "context_window" && evt.context_window) {
                                    const cw = evt.context_window;
                                    if (cw.context_window && cw.current_context_window !== undefined) {
                                        session.contextPct = Math.round((cw.current_context_window / cw.context_window) * 100);
                                    }
                                }
                                if (evt.type === "assistant") {
                                    const msgContent = evt.message?.content || [];
                                    for (const block of msgContent) {
                                        if (block.type === "text" && block.text?.trim()) {
                                            postToFeed(session.sessionId, session.opsDbUrl, block.text.trim(), "console", "agent");
                                        }
                                        else if (block.type === "tool_use") {
                                            const inputSnip = JSON.stringify(block.input || {}).slice(0, 200);
                                            postToFeed(session.sessionId, session.opsDbUrl, `🔧 \`${block.name}\` ${inputSnip}`, "tool_call", "agent");
                                        }
                                    }
                                }
                                if (evt.type === "tool_result") {
                                    const resultText = (evt.content?.[0]?.text || "").slice(0, 500);
                                    if (resultText) {
                                        postToFeed(session.sessionId, session.opsDbUrl, `📄 ${resultText}`, "tool_result", "agent");
                                    }
                                }
                                if (evt.type === "result") {
                                    const resultText = evt.result || evt.output || "";
                                    postToFeed(session.sessionId, session.opsDbUrl, `✅ Session complete: ${resultText.slice(0, 1000)}`, "completion", "agent");
                                    session.status = "completed";
                                }
                            }
                            catch { }
                        }
                    });
                    proc.stderr?.on("data", (chunk) => {
                        const text = chunk.toString().trim();
                        if (text)
                            console.error(`[session:${job_id}] stderr:`, text);
                    });
                    proc.on("close", (code) => {
                        const s = cliSessions.get(job_id);
                        if (s) {
                            if (s.status === "running" || s.status === "paused") {
                                s.status = code === 0 ? "completed" : "cancelled";
                            }
                            postToFeed(s.sessionId, s.opsDbUrl, `🏁 Session ${job_id} exited with code ${code}. Status: ${s.status}`, "completion", "agent");
                        }
                        try {
                            if (rules)
                                fs.unlinkSync(rulesFile);
                        }
                        catch { }
                    });
                    proc.on("error", (err) => {
                        const s = cliSessions.get(job_id);
                        if (s) {
                            s.status = "cancelled";
                            postToFeed(s.sessionId, s.opsDbUrl, `❌ Session ${job_id} error: ${err.message}`, "completion", "agent");
                        }
                    });
                    return { content: [{ type: "text", text: JSON.stringify({ job_id, status: "started", pid: proc.pid }) }] };
                }
                case "pause_session": {
                    const { job_id } = args;
                    const s = cliSessions.get(job_id);
                    if (!s)
                        throw new Error(`Session ${job_id} not found`);
                    if (s.status !== "running")
                        throw new Error(`Session ${job_id} is not running (status: ${s.status})`);
                    s.proc.kill("SIGSTOP");
                    s.status = "paused";
                    return { content: [{ type: "text", text: JSON.stringify({ job_id, status: "paused" }) }] };
                }
                case "resume_session": {
                    const { job_id } = args;
                    const s = cliSessions.get(job_id);
                    if (!s)
                        throw new Error(`Session ${job_id} not found`);
                    if (s.status !== "paused")
                        throw new Error(`Session ${job_id} is not paused (status: ${s.status})`);
                    s.proc.kill("SIGCONT");
                    s.status = "running";
                    return { content: [{ type: "text", text: JSON.stringify({ job_id, status: "running" }) }] };
                }
                case "cancel_session": {
                    const { job_id } = args;
                    const s = cliSessions.get(job_id);
                    if (!s)
                        throw new Error(`Session ${job_id} not found`);
                    s.proc.kill("SIGTERM");
                    s.status = "cancelled";
                    return { content: [{ type: "text", text: JSON.stringify({ job_id, status: "cancelled" }) }] };
                }
                case "get_session_status": {
                    const { job_id } = args;
                    const s = cliSessions.get(job_id);
                    if (!s)
                        throw new Error(`Session ${job_id} not found`);
                    const costUsd = (s.tokenInput * 3 + s.tokenOutput * 15) / 1_000_000;
                    return {
                        content: [{
                                type: "text",
                                text: JSON.stringify({
                                    job_id,
                                    status: s.status,
                                    pid: s.proc.pid,
                                    context_pct: s.contextPct,
                                    model: s.model,
                                    token_input: s.tokenInput,
                                    token_output: s.tokenOutput,
                                    token_cache: s.tokenCache,
                                    estimated_cost_usd: Math.round(costUsd * 10000) / 10000,
                                    started_at: s.startedAt.toISOString(),
                                    last_activity: s.lastActivity.toISOString(),
                                }),
                            }],
                    };
                }
                case "send_message": {
                    // ZI-18755: Deliver user message to running CLI session via stdin
                    const { job_id, message } = args;
                    const s = cliSessions.get(job_id);
                    if (!s)
                        throw new Error(`Session ${job_id} not found`);
                    if (s.status !== "running")
                        throw new Error(`Session ${job_id} is not running (status: ${s.status})`);
                    if (!s.proc.stdin)
                        throw new Error(`Session ${job_id} stdin not available`);
                    const payload = JSON.stringify({
                        type: "user",
                        message: { role: "user", content: [{ type: "text", text: message }] },
                    });
                    s.proc.stdin.write(payload + "\n");
                    s.lastActivity = new Date();
                    return { content: [{ type: "text", text: JSON.stringify({ job_id, sent: true, message_preview: message.slice(0, 100) }) }] };
                }
                case "list_sessions": {
                    const result = Array.from(cliSessions.entries()).map(([id, s]) => ({
                        job_id: id,
                        status: s.status,
                        pid: s.proc.pid,
                        started_at: s.startedAt.toISOString(),
                        last_activity: s.lastActivity.toISOString(),
                        model: s.model,
                        context_pct: s.contextPct,
                    }));
                    return { content: [{ type: "text", text: JSON.stringify(result) }] };
                }
                case "git_pull": {
                    const { repo } = args;
                    const working_dir = `/home/david/${repo}`;
                    const r = (0, child_process_1.spawnSync)("git", ["pull", "--rebase", "origin"], { cwd: working_dir, encoding: "utf8" });
                    const output = (r.stdout || "") + (r.stderr || "");
                    return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
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
// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "9000", 10);
app.listen(PORT, () => {
    console.log(`container-mcp v2.0.0 running on port ${PORT}`);
    console.log(`  SSE:    http://localhost:${PORT}/sse`);
    console.log(`  Health: http://localhost:${PORT}/health`);
});
