import { randomUUID } from "crypto";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "pg";
import { withDbClient, notifySessionMessage, buildSpawnMessage } from "./db.js";
import { postToFeed, _feedClients } from "./feed.js";
import { taskLogs } from "./task-logs.js";
import { populateCacheForProject, writeCacheEntry } from "./jira-confluence.js";
import { bootstrapSession } from "./bootstrap.js";
import { deployProject } from "./tools/deploy-project.js";
import { transitionSession, nextAllowedActions, SESSION_TRANSITIONS, type SessionStatus } from "./state-machine.js";
import { getModelStatus, probeModels } from "./model-registry.js";

const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "claude-sonnet-4-6";

function modelCostPerMillion(model?: string): { input: number; output: number } {
  if (!model) return { input: 3, output: 15 };
  const m = model.toLowerCase();
  if (m.includes("haiku")) return { input: 0.25, output: 1.25 };
  if (m.includes("opus")) return { input: 15, output: 75 };
  return { input: 3, output: 15 };
}

export function createMcpServer() {
  const server = new Server(
    { name: "container-mcp", version: "2.2.0" },
    { capabilities: { tools: {} } }
  );

  const codeTaskEnabled = process.env.CODE_TASK_ENABLED === "true";

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
              description: "Model to use. Accepts aliases: 'fast'/'haiku', 'balanced'/'sonnet' (default), 'smart'/'opus', 'compat'/'external'. Or pass exact model ID. Registry handles failover automatically.",
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
      {
        name: "transition_session",
        description: "Atomically transition a session's status with graph validation. Rejects invalid transitions (e.g. completed → executing). Uses optimistic concurrency to prevent races.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "The ops-db session ID" },
            to_status: {
              type: "string",
              enum: ["pending", "active", "executing", "awaiting_approval", "planning", "paused", "completed", "failed"],
              description: "Target status",
            },
          },
          required: ["session_id", "to_status"],
        },
      },
      {
        name: "get_session_provenance",
        description: "Get full provenance and timeline for a session: status, next allowed transitions, branch, worktree, Jira keys, cost, turn count, and message timeline.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "The ops-db session ID" },
          },
          required: ["session_id"],
        },
      },
      {
        name: "get_container_inventory",
        description: "Get a full inventory of this container: version, active sessions, worktrees, tool registry, and health checks.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "get_model_status",
        description: "Returns the current health, availability, and configuration of all registered coding models. Use this to understand what models are available, which are healthy, what aliases map to which models, and what would be selected for a new task.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "probe_models",
        description: "Actively probe all registered models for accessibility (makes a lightweight 1-token API call). Updates health state. Returns per-model results including latency. Only probes models accessible via configured API key or OPENAI_BASE_URL.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
      switch (name) {