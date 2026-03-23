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
exports.createMcpServer = createMcpServer;
const crypto_1 = require("crypto");
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const pg_1 = require("pg");
const db_js_1 = require("./db.js");
const feed_js_1 = require("./feed.js");
const task_logs_js_1 = require("./task-logs.js");
const jira_confluence_js_1 = require("./jira-confluence.js");
const bootstrap_js_1 = require("./bootstrap.js");
const deploy_project_js_1 = require("./tools/deploy-project.js");
const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "claude-sonnet-4-6";
function modelCostPerMillion(model) {
    if (!model)
        return { input: 3, output: 15 };
    const m = model.toLowerCase();
    if (m.includes("haiku"))
        return { input: 0.25, output: 1.25 };
    if (m.includes("opus"))
        return { input: 15, output: 75 };
    return { input: 3, output: 15 };
}
function createMcpServer() {
    const server = new index_js_1.Server({ name: "container-mcp", version: "2.2.0" }, { capabilities: { tools: {} } });
    const codeTaskEnabled = process.env.CODE_TASK_ENABLED === "true";
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({
        tools: [
            ...(codeTaskEnabled ? [{
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
                                description: "JSON object defining custom sub-agents available to this task.",
                            },
                            allowed_tools: {
                                type: "array",
                                items: { type: "string" },
                                description: "Whitelist of tools the CLI may use.",
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
                }] : []),
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
                        ash_session_key: { type: "string", description: "OpenClaw session key of the spawning Ash session (e.g. agent:main:openai:xxxx) for callback. Defaults to OPENCLAW_SESSION_KEY env var if not provided." },
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
                            description: "List of project_id values from the projects table. Defaults to all three if omitted.",
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
                description: "Deploy a project by ID. Spawns a CLI agent (Sonnet) that inspects topology files, builds, deploys, and smoke-tests the project. Returns immediately with a task ID; smoke_status is 'pending' until the agent posts a checkpoint to the session feed.",
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
                description: "Register a new project in the projects table (or update an existing one). Sets display name, description, build command, working directory, default container, Jira keys, Confluence root, and smoke URL. Auto-detects build command from the filesystem if not provided. Note: deploy_cmd is deprecated — deployment is handled by the CLI agent via deploy_project.",
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
                description: "Orchestrate a new dev session end-to-end. Resolves the project (exact match on project_id or project_hint), checks for existing active session, warms Jira/Confluence cache, creates/finds Jira issue, composes task brief, creates session record, and launches BOOTSTRAP planning pass via Claude Code CLI. If no project matches and no project_id is provided, returns needs_project=true with available_projects — the caller should then pick or create a project_id and call again.",
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
                        project_id: {
                            type: "string",
                            description: "Explicit project_id. If it matches an existing project, that project is used. If it doesn't exist, a new project is auto-created with the given display_name/description. If omitted, the server tries to match from project_hint.",
                        },
                        project_hint: {
                            type: "string",
                            description: "Optional project_id or display_name to match against existing projects (exact, case-insensitive). Ignored if project_id is provided.",
                        },
                        display_name: {
                            type: "string",
                            description: "Display name for auto-created projects (e.g. 'Ash Dashboard'). Only used when project_id is new.",
                        },
                        description: {
                            type: "string",
                            description: "Description for auto-created projects. Only used when project_id is new.",
                        },
                        slack_thread_url: {
                            type: "string",
                            description: "Slack thread URL to associate with the session (optional)",
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
                    if (process.env.CODE_TASK_ENABLED !== "true") {
                        return { content: [{ type: "text", text: "code_task is disabled on this container (CODE_TASK_ENABLED not set to true)" }], isError: true };
                    }
                    const { instruction, working_dir, driver = "claude", task_id, max_turns = 30, budget_usd = 5.0, timeout_seconds = 900, task_rules, base_rules_path = "/home/david/.rules/base.md", project_rules_path = "/.rules/project.md", session_id, ops_db_url, model, effort, agents, allowed_tools, resume_claude_session_id, add_dirs, } = args;
                    const dbUrl = ops_db_url || process.env.OPS_DB_URL;
                    const taskId = task_id || (0, crypto_1.randomUUID)();
                    task_logs_js_1.taskLogs.set(taskId, []);
                    const log = (line) => task_logs_js_1.taskLogs.get(taskId).push(line);
                    const debugLogPath = `/tmp/task-${taskId}-debug.log`;
                    (0, feed_js_1.postToFeed)(session_id, dbUrl, `🤖 Model: ${model || "default (account)"} | driver: ${driver} | effort: ${effort || "medium"} | task_id: ${taskId}`);
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
                                claudeArgs.push("--model", model || DEFAULT_MODEL);
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
                                if (session_id && dbUrl) {
                                    const resolvedModel = model || "default";
                                    void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                        await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model TEXT`).catch(() => { });
                                        await client.query(`UPDATE sessions SET model = $1 WHERE session_id = $2`, [resolvedModel, session_id]);
                                    }).catch(() => { });
                                }
                                let output = "";
                                const timer = setTimeout(() => { proc.kill("SIGTERM"); }, timeout_seconds * 1000);
                                const toolUseMap = new Map();
                                proc.stdout.on("data", (chunk) => {
                                    const lines = chunk.toString().split("\n");
                                    for (const line of lines) {
                                        if (!line.trim())
                                            continue;
                                        log(line);
                                        try {
                                            const parsed = JSON.parse(line);
                                            if (parsed.type === "result") {
                                                const claudeSessionId = parsed.session_id;
                                                if (claudeSessionId && session_id && dbUrl) {
                                                    void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                                        await client.query(`UPDATE sessions SET claude_session_id = $1, updated_at = now() WHERE session_id = $2`, [claudeSessionId, session_id]);
                                                    }).catch(() => { });
                                                }
                                                output = parsed.result || parsed.output || JSON.stringify(parsed);
                                                (0, feed_js_1.postToFeed)(session_id, dbUrl, `✅ Task complete\n\n${output.slice(0, 4000)}`);
                                                const usage = parsed.usage;
                                                if (usage && (usage.input_tokens || usage.output_tokens) && session_id && dbUrl) {
                                                    const inputTokens = usage.input_tokens || 0;
                                                    const outputTokens = usage.output_tokens || 0;
                                                    const totalTokens = inputTokens + outputTokens;
                                                    const { input: inputCostPerM, output: outputCostPerM } = modelCostPerMillion(model);
                                                    const costUsd = (inputTokens / 1_000_000 * inputCostPerM) + (outputTokens / 1_000_000 * outputCostPerM);
                                                    void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                                        await client.query(`UPDATE sessions SET token_usage = COALESCE(token_usage, 0) + $1, cost_usd = COALESCE(cost_usd, 0) + $2 WHERE session_id = $3`, [totalTokens, costUsd, session_id]);
                                                    }).catch((err) => console.error('[token-usage] Failed to update token usage:', err));
                                                }
                                            }
                                            else if (parsed.type === "assistant") {
                                                const content = parsed.message?.content || [];
                                                for (const block of content) {
                                                    if (block.type === "tool_use") {
                                                        toolUseMap.set(block.id, block.name);
                                                        const toolInput = JSON.stringify(block.input || {}).slice(0, 500);
                                                        (0, feed_js_1.postToFeed)(session_id, dbUrl, `🔧 \`${block.name}\` ${toolInput}`);
                                                    }
                                                    else if (block.type === "thinking" && block.thinking?.trim()) {
                                                        (0, feed_js_1.postToFeed)(session_id, dbUrl, `🧠 ${block.thinking.trim().slice(0, 600)}`);
                                                    }
                                                    else if (block.type === "text" && block.text?.trim() && !parsed.message?.usage) {
                                                        const text = block.text.trim().slice(0, 1000);
                                                        if (text.length > 20)
                                                            (0, feed_js_1.postToFeed)(session_id, dbUrl, `💭 ${text}`);
                                                    }
                                                }
                                            }
                                            else if (parsed.type === "user") {
                                                const content = parsed.message?.content || [];
                                                for (const block of content) {
                                                    if (block.type === "tool_result") {
                                                        const toolName = toolUseMap.get(block.tool_use_id) || block.tool_use_id || "unknown";
                                                        let resultText = "";
                                                        if (typeof block.content === "string")
                                                            resultText = block.content;
                                                        else if (Array.isArray(block.content))
                                                            resultText = block.content.map((c) => c.text || "").join("\n");
                                                        if (resultText)
                                                            (0, feed_js_1.postToFeed)(session_id, dbUrl, `📄 ${toolName} → ${resultText.slice(0, 800)}`);
                                                    }
                                                }
                                            }
                                        }
                                        catch { }
                                    }
                                });
                                proc.stderr.on("data", (chunk) => {
                                    const text = chunk.toString();
                                    log("[stderr] " + text);
                                    (0, feed_js_1.postToFeed)(session_id, dbUrl, text.slice(0, 500), "system", "console");
                                });
                                proc.on("close", (code) => {
                                    clearTimeout(timer);
                                    try {
                                        fs.unlinkSync(rulesFile);
                                    }
                                    catch { }
                                    (0, feed_js_1.postToFeed)(session_id, dbUrl, `✅ Process ${taskId} exited with code ${code}. Debug log: ${debugLogPath}`);
                                });
                            }
                            catch (err) {
                                console.error(`[code_task] Error in async spawn: ${err.message}`);
                                (0, feed_js_1.postToFeed)(session_id, dbUrl, `❌ Task ${taskId} failed to start: ${err.message}`);
                            }
                        })().catch((err) => {
                            console.error(`[code_task] Unhandled rejection: ${err.message}`);
                        });
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
                                                    (0, feed_js_1.postToFeed)(session_id, dbUrl, `💭 ${(parsed.text || "").slice(0, 500)}`);
                                                }
                                                else if (parsed.say === "tool") {
                                                    (0, feed_js_1.postToFeed)(session_id, dbUrl, `🔧 ${(parsed.text || "").slice(0, 300)}`);
                                                }
                                                else if (parsed.say === "completion_result") {
                                                    (0, feed_js_1.postToFeed)(session_id, dbUrl, `✅ Done: ${(parsed.text || "").slice(0, 1000)}`);
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
                                    (0, feed_js_1.postToFeed)(session_id, dbUrl, `✅ Process ${taskId} exited with code ${code}`);
                                });
                            }
                            catch (err) {
                                console.error(`[code_task] Error in async spawn: ${err.message}`);
                                (0, feed_js_1.postToFeed)(session_id, dbUrl, `❌ Task ${taskId} failed to start: ${err.message}`);
                            }
                        })().catch((err) => {
                            console.error(`[code_task] Unhandled rejection: ${err.message}`);
                        });
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
                    const logs = task_logs_js_1.taskLogs.get(task_id) || [];
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
                    const run = (gitArgs) => (0, child_process_1.spawnSync)("git", gitArgs, { cwd: working_dir, encoding: "utf8" });
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
                    const result = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
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
                    await (0, jira_confluence_js_1.writeCacheEntry)(dbUrl, cache_key, source_type, content_hash, source_updated, summary);
                    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
                }
                case "listen_for_approval": {
                    const { session_id, timeout_seconds = 1800 } = args;
                    const dbUrl = process.env.OPS_DB_URL;
                    const result = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
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
                    (0, child_process_1.spawnSync)("git", ["fetch", "origin", base_branch], { cwd: repoDir, encoding: "utf8" });
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
                    let worktreeBranch = null;
                    if (delete_branch) {
                        const branchR = (0, child_process_1.spawnSync)("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree_path, encoding: "utf8" });
                        worktreeBranch = branchR.status === 0 ? branchR.stdout.trim() : null;
                    }
                    const mainR = (0, child_process_1.spawnSync)("git", ["worktree", "list", "--porcelain"], { cwd: worktree_path, encoding: "utf8" });
                    let mainRepoDir = null;
                    if (mainR.status === 0) {
                        const match = mainR.stdout.match(/^worktree (.+)$/m);
                        if (match)
                            mainRepoDir = match[1];
                    }
                    const removeR = (0, child_process_1.spawnSync)("git", ["worktree", "remove", worktree_path, "--force"], {
                        cwd: mainRepoDir || worktree_path,
                        encoding: "utf8",
                    });
                    const output = (removeR.stdout || "") + (removeR.stderr || "");
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
                                    const bootstrapInsert = await bootstrapClient.query("INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING message_id, created_at", [chatSessionId, "system", contextMsg, "system_context"]);
                                    if (bootstrapInsert.rows[0]) {
                                        await (0, db_js_1.notifySessionMessage)(bootstrapClient, chatSessionId, {
                                            id: bootstrapInsert.rows[0].message_id,
                                            message_id: bootstrapInsert.rows[0].message_id,
                                            session_id: chatSessionId,
                                            role: "system",
                                            message_type: "system_context",
                                            content: contextMsg,
                                            created_at: bootstrapInsert.rows[0].created_at,
                                        }).catch(() => { });
                                    }
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
                    const claudeArgs = [
                        "-p", message,
                        "--output-format", "stream-json",
                        "--verbose",
                        "--dangerously-skip-permissions",
                        "--model", DEFAULT_MODEL,
                    ];
                    if (existingClaudeSessionId) {
                        claudeArgs.push("--resume", existingClaudeSessionId);
                    }
                    if (systemContextFile) {
                        claudeArgs.push("--append-system-prompt-file", systemContextFile);
                    }
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
                                                if (chatSessionId && text.length > 0) {
                                                    void (async () => {
                                                        if (!chatSessionId || !dbUrl)
                                                            return;
                                                        const key = `${chatSessionId}::${dbUrl}`;
                                                        if (!feed_js_1._feedClients.has(key)) {
                                                            const client = new pg_1.Client({ connectionString: dbUrl });
                                                            await client.connect();
                                                            feed_js_1._feedClients.set(key, { client, queue: Promise.resolve() });
                                                        }
                                                        const entry = feed_js_1._feedClients.get(key);
                                                        entry.queue = entry.queue.then(async () => {
                                                            try {
                                                                const insertRes = await entry.client.query("INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING message_id, created_at", [chatSessionId, "coding_agent", text, "execution_log"]);
                                                                if (insertRes.rows[0]) {
                                                                    await (0, db_js_1.notifySessionMessage)(entry.client, chatSessionId, {
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
                                                (0, feed_js_1.postToFeed)(chatSessionId, dbUrl, `🔧 \`${block.name}\` ${JSON.stringify(block.input || {}).slice(0, 200)}`, "coding_agent", "execution_log");
                                            }
                                        }
                                    }
                                    else if (parsed.type === "result") {
                                        resultClaudeSessionId = parsed.session_id || null;
                                        if (parsed.usage) {
                                            const inputTokens = parsed.usage.input_tokens || 0;
                                            const outputTokens = parsed.usage.output_tokens || 0;
                                            tokensUsed = inputTokens + outputTokens;
                                            const { input: inputCostPerM, output: outputCostPerM } = modelCostPerMillion();
                                            costUsd = (inputTokens / 1_000_000 * inputCostPerM) + (outputTokens / 1_000_000 * outputCostPerM);
                                        }
                                        const resultText = (parsed.result || parsed.output || "");
                                        if (resultText && chatSessionId && dbUrl) {
                                            (0, feed_js_1.postToFeed)(chatSessionId, dbUrl, `✅ Done`, "coding_agent", "execution_log");
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
                            if (chatSessionId && fullAssistantText.trim()) {
                                void (async () => {
                                    if (!chatSessionId || !dbUrl)
                                        return;
                                    const key = `${chatSessionId}::${dbUrl}`;
                                    if (!feed_js_1._feedClients.has(key)) {
                                        const client = new pg_1.Client({ connectionString: dbUrl });
                                        await client.connect();
                                        feed_js_1._feedClients.set(key, { client, queue: Promise.resolve() });
                                    }
                                    const entry = feed_js_1._feedClients.get(key);
                                    entry.queue = entry.queue.then(async () => {
                                        try {
                                            const insertRes = await entry.client.query("INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING message_id, created_at", [chatSessionId, "coding_agent", fullAssistantText.trim(), "chat"]);
                                            if (insertRes.rows[0]) {
                                                await (0, db_js_1.notifySessionMessage)(entry.client, chatSessionId, {
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
                                void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
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
                                args: { agentId: "dev-lead", task: await (0, db_js_1.buildSpawnMessage)(sessionId, process.env.OPS_DB_URL ?? ''), cwd: "/home/openclaw/agents/dev-lead" },
                            }),
                        });
                        if (!resp.ok) {
                            const text = await resp.text();
                            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Gateway ${resp.status}: ${text}` }) }] };
                        }
                        const parsed = await resp.json().catch(() => ({}));
                        const childSessionKey = parsed?.childSessionKey ?? parsed?.session_key ?? null;
                        if (childSessionKey) {
                            const dbUrl = process.env.OPS_DB_URL;
                            if (dbUrl) {
                                void (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                    await client.query(`UPDATE sessions SET openclaw_session_key = $1, updated_at = now() WHERE session_id = $2`, [childSessionKey, sessionId]);
                                }).catch((e) => console.warn(`[spawn_dev_lead] store openclaw_session_key failed: ${e.message}`));
                            }
                        }
                        return { content: [{ type: "text", text: JSON.stringify({ ok: true, session_id: sessionId, childSessionKey }) }] };
                    }
                    catch (fetchErr) {
                        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: fetchErr.message }) }] };
                    }
                }
                case "create_session": {
                    const { title, repo, container: sessionContainer = "dev-david", task_brief, slack_thread_url, jira_keys, ash_session_key, } = args;
                    const dbUrl = process.env.OPS_DB_URL;
                    if (!dbUrl) {
                        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
                    }
                    const firstKey = jira_keys?.split(",")[0]?.trim().toLowerCase().replace(/-/g, "") ?? "";
                    const ts = Date.now();
                    const sessionId = firstKey
                        ? `sess-${firstKey}-${ts}`
                        : `sess-${(0, crypto_1.randomUUID)().slice(0, 8)}-${ts}`;
                    const sessionUrl = `https://dev-sessions.ash.zennya.app/sessions/${sessionId}`;
                    const jiraKeysArr = jira_keys
                        ? `{${jira_keys.split(",").map((k) => k.trim()).join(",")}}`
                        : null;
                    try {
                        const resolvedAshKey = ash_session_key || process.env.OPENCLAW_SESSION_KEY || null;
                        await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                            await client.query(`INSERT INTO sessions (session_id, project_id, container, repo, status, session_type, title, prompt_preview, jira_issue_keys, slack_thread_url, gateway_parent_key, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'active', 'dev', $5, $6, $7::text[], $8, $9, now(), now())`, [sessionId, repo, sessionContainer, repo, title, task_brief.slice(0, 500), jiraKeysArr, slack_thread_url || null, resolvedAshKey]);
                            const msgId = `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
                            await client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
                 VALUES ($1, $2, 'user', $3, 'task_brief', now())`, [msgId, sessionId, task_brief]);
                        });
                        try {
                            const parsedJiraKeys = jira_keys
                                ? jira_keys.split(",").map((k) => k.trim()).filter(Boolean)
                                : [];
                            const projRow = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                const r = await client.query(`SELECT confluence_root_id FROM projects WHERE project_id = $1`, [repo]);
                                return r.rows[0] ?? null;
                            });
                            const confluenceRootId = projRow?.confluence_root_id ?? null;
                            await (0, jira_confluence_js_1.populateCacheForProject)(dbUrl, parsedJiraKeys, confluenceRootId);
                            console.log(`[create_session] cache warmed: jira=${parsedJiraKeys.join(",") || "none"} confluence=${confluenceRootId ?? "none"}`);
                        }
                        catch (cacheErr) {
                            console.warn(`[create_session] cache warm failed (non-fatal): ${cacheErr.message}`);
                        }
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
                                    args: { agentId: "dev-lead", task: await (0, db_js_1.buildSpawnMessage)(sessionId, dbUrl, ash_session_key), cwd: "/home/openclaw/agents/dev-lead" },
                                }),
                            });
                            if (!resp.ok) {
                                const text = await resp.text();
                                spawnError = `Gateway ${resp.status}: ${text}`;
                            }
                            else {
                                const parsed = await resp.json().catch(() => ({}));
                                childSessionKey = parsed?.result?.details?.childSessionKey ?? parsed?.details?.childSessionKey ?? parsed?.childSessionKey ?? parsed?.session_key ?? null;
                                spawnOk = true;
                            }
                        }
                        catch (fetchErr) {
                            spawnError = fetchErr.message;
                        }
                        if (!spawnOk) {
                            await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                await client.query(`INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
                   VALUES (gen_random_uuid(), $1, 'dev_lead', $2, 'console', now())`, [sessionId, `⚠️ Session created but spawn_dev_lead failed: ${spawnError}`]);
                            }).catch(() => { });
                            return { content: [{ type: "text", text: JSON.stringify({ ok: false, session_id: sessionId, session_url: sessionUrl, error: `spawn failed: ${spawnError}` }) }] };
                        }
                        // Persist the OpenClaw session key so we can query dev-lead status later
                        if (childSessionKey) {
                            await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                await client.query(`UPDATE sessions SET openclaw_session_key = $1, updated_at = now() WHERE session_id = $2`, [childSessionKey, sessionId]);
                            }).catch((e) => console.warn(`[create_session] store openclaw_session_key failed: ${e.message}`));
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
                            const projRow = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
                                const r = await client.query(`SELECT confluence_root_id FROM projects WHERE project_id = $1`, [repoId]);
                                return r.rows[0] ?? null;
                            });
                            if (!projRow) {
                                results[repoId] = "not found in projects table";
                                continue;
                            }
                            const confluenceRootId = projRow.confluence_root_id ?? null;
                            await (0, jira_confluence_js_1.populateCacheForProject)(dbUrl, [], confluenceRootId);
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
                    const row = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
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
                    const { project_id: projectId, display_name, description: projDescription, working_dir: inputWorkingDir, default_container, build_cmd: inputBuildCmd, smoke_url: inputSmokeUrl, jira_issue_keys: jiraKeysStr, confluence_root_id, } = args;
                    const dbUrl = process.env.OPS_DB_URL;
                    if (!dbUrl) {
                        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
                    }
                    let workingDir = inputWorkingDir || null;
                    if (!workingDir) {
                        for (const candidate of [`/home/david/${projectId}`, `/home/openclaw/apps/${projectId}`, `/opt/${projectId}`]) {
                            if (fs.existsSync(candidate)) {
                                workingDir = candidate;
                                break;
                            }
                        }
                    }
                    let buildCmd = inputBuildCmd || null;
                    const deployCmd = null; // deprecated — deploy_project uses CLI agent topology detection
                    if (workingDir && !buildCmd) {
                        const hasSwarmYml = fs.existsSync(path.join(workingDir, 'swarm.yml'));
                        const hasDockerfile = fs.existsSync(path.join(workingDir, 'Dockerfile'));
                        const hasPkgJson = fs.existsSync(path.join(workingDir, 'package.json'));
                        const hasRequirements = fs.existsSync(path.join(workingDir, 'requirements.txt'));
                        const hasPyproject = fs.existsSync(path.join(workingDir, 'pyproject.toml'));
                        let detectedBuild = null;
                        if (hasSwarmYml || hasDockerfile) {
                            detectedBuild = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
                        }
                        else if (hasPkgJson) {
                            detectedBuild = `cd ${workingDir} && npm install && npm run build`;
                        }
                        else if (hasRequirements || hasPyproject) {
                            detectedBuild = `cd ${workingDir} && pip install -r ${hasRequirements ? 'requirements.txt' : '.'} -q`;
                        }
                        buildCmd = detectedBuild;
                    }
                    const jiraKeysArr = jiraKeysStr
                        ? `{${jiraKeysStr.split(",").map((k) => k.trim()).filter(Boolean).join(",")}}`
                        : null;
                    try {
                        await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
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
                        const row = await (0, db_js_1.withDbClient)(dbUrl, async (client) => {
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
                    const { user_request, user_id, project_id: bsProjectId, project_hint, display_name: bsDisplayName, description: bsDescription, slack_thread_url: bsSlackThreadUrl } = args;
                    const result = await (0, bootstrap_js_1.bootstrapSession)({ user_request, user_id, project_id: bsProjectId, project_hint, display_name: bsDisplayName, description: bsDescription, slack_thread_url: bsSlackThreadUrl });
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
