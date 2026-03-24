import { spawnSync } from "child_process";
import type { ToolPolicyClass } from "../state-machine.js";

export interface ToolDefinition {
  name: string;
  description: string;
  policy_class: ToolPolicyClass;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export const gitToolDefinitions: ToolDefinition[] = [
  {
    name: "git_status",
    description: "Get git status for a repo (branch, staged, unstaged, untracked files)",
    policy_class: "read_only",
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
    policy_class: "mutating",
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
    policy_class: "mutating",
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
    policy_class: "mutating",
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
    policy_class: "mutating",
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
    policy_class: "mutating",
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
    policy_class: "mutating",
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
    policy_class: "mutating",
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
    policy_class: "mutating",
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
    policy_class: "read_only",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Short repo name (resolved to /home/david/<repo>)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "get_diff",
    description: "Get git diff for a working directory",
    policy_class: "read_only",
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
    policy_class: "read_only",
    inputSchema: {
      type: "object",
      properties: {
        working_dir: { type: "string" },
      },
      required: ["working_dir"],
    },
  },
];

export async function handleGitTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  switch (name) {
    case "git_status": {
      const { repo } = args as { repo: string };
      const working_dir = `/home/david/${repo}`;
      const branchR = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: working_dir, encoding: "utf8" });
      const branch = branchR.stdout.trim();
      const statusR = spawnSync("git", ["status", "--short"], { cwd: working_dir, encoding: "utf8" });
      const staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];
      for (const line of statusR.stdout.split("\n")) {
        if (!line) continue;
        const indexChar = line[0];
        const wtChar = line[1];
        const file = line.slice(3);
        if (indexChar === "?" && wtChar === "?") {
          untracked.push(file);
        } else {
          if (indexChar !== " " && indexChar !== "?") staged.push(file);
          if (wtChar !== " " && wtChar !== "?") unstaged.push(file);
        }
      }
      return { content: [{ type: "text", text: JSON.stringify({ branch, staged, unstaged, untracked, exit_code: branchR.status ?? -1 }) }] };
    }

    case "git_checkout": {
      const { repo, branch, create = false } = args as { repo: string; branch: string; create?: boolean };
      const working_dir = `/home/david/${repo}`;
      const gitArgs = create ? ["checkout", "-b", branch] : ["checkout", branch];
      const r = spawnSync("git", gitArgs, { cwd: working_dir, encoding: "utf8" });
      const output = (r.stdout || "") + (r.stderr || "");
      return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
    }

    case "git_add": {
      const { repo, files } = args as { repo: string; files: string[] };
      const working_dir = `/home/david/${repo}`;
      const r = spawnSync("git", ["add", ...files], { cwd: working_dir, encoding: "utf8" });
      const output = (r.stdout || "") + (r.stderr || "");
      return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
    }

    case "git_commit": {
      const { repo, message } = args as { repo: string; message: string };
      const working_dir = `/home/david/${repo}`;
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "Dev-Lead Agent",
        GIT_AUTHOR_EMAIL: "dev-lead@zennya.app",
        GIT_COMMITTER_NAME: "Dev-Lead Agent",
        GIT_COMMITTER_EMAIL: "dev-lead@zennya.app",
      };
      const r = spawnSync("git", ["commit", "-m", message], { cwd: working_dir, encoding: "utf8", env: gitEnv });
      const output = (r.stdout || "") + (r.stderr || "");
      return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
    }

    case "git_push": {
      const { repo, branch, force = false } = args as { repo: string; branch?: string; force?: boolean };
      const working_dir = `/home/david/${repo}`;
      const gitArgs = ["push"];
      if (force) gitArgs.push("--force");
      gitArgs.push("origin");
      if (branch) gitArgs.push(branch);
      const r = spawnSync("git", gitArgs, { cwd: working_dir, encoding: "utf8" });
      const output = (r.stdout || "") + (r.stderr || "");
      return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
    }

    case "git_merge": {
      const { repo, branch, no_ff = true } = args as { repo: string; branch: string; no_ff?: boolean };
      const working_dir = `/home/david/${repo}`;
      const gitArgs = ["merge"];
      if (no_ff) gitArgs.push("--no-ff");
      gitArgs.push(branch);
      const r = spawnSync("git", gitArgs, { cwd: working_dir, encoding: "utf8" });
      const output = (r.stdout || "") + (r.stderr || "");
      return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
    }

    case "git_pull": {
      const { repo } = args as { repo: string };
      const working_dir = `/home/david/${repo}`;
      const r = spawnSync("git", ["pull", "--rebase", "origin"], { cwd: working_dir, encoding: "utf8" });
      const output = (r.stdout || "") + (r.stderr || "");
      return { content: [{ type: "text", text: JSON.stringify({ success: r.status === 0, output, exit_code: r.status ?? -1 }) }] };
    }

    case "create_git_worktree": {
      const { repo, base_branch = "main", worktree_id } = args as { repo: string; base_branch?: string; worktree_id?: string };
      const repoDir = `/home/david/${repo}`;
      const id = worktree_id || `wt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const worktreePath = `/tmp/${repo}-${id}`;
      const branchName = `worktree/${id}`;

      spawnSync("git", ["fetch", "origin", base_branch], { cwd: repoDir, encoding: "utf8" });

      const r = spawnSync("git", ["worktree", "add", "-b", branchName, worktreePath, `origin/${base_branch}`], {
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
      const { worktree_path, delete_branch = false } = args as { worktree_path: string; delete_branch?: boolean };

      let worktreeBranch: string | null = null;
      if (delete_branch) {
        const branchR = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree_path, encoding: "utf8" });
        worktreeBranch = branchR.status === 0 ? branchR.stdout.trim() : null;
      }

      const mainR = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: worktree_path, encoding: "utf8" });
      let mainRepoDir: string | null = null;
      if (mainR.status === 0) {
        const match = mainR.stdout.match(/^worktree (.+)$/m);
        if (match) mainRepoDir = match[1];
      }

      const removeR = spawnSync("git", ["worktree", "remove", worktree_path, "--force"], {
        cwd: mainRepoDir || worktree_path,
        encoding: "utf8",
      });
      const output = (removeR.stdout || "") + (removeR.stderr || "");

      let branchDeleted = false;
      if (delete_branch && worktreeBranch && mainRepoDir && removeR.status === 0) {
        const delR = spawnSync("git", ["branch", "-D", worktreeBranch], { cwd: mainRepoDir, encoding: "utf8" });
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
      const { repo } = args as { repo: string };
      const repoDir = `/home/david/${repo}`;
      const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repoDir, encoding: "utf8" });
      if (r.status !== 0) {
        const output = (r.stdout || "") + (r.stderr || "");
        return { content: [{ type: "text", text: JSON.stringify({ success: false, output, exit_code: r.status ?? -1 }) }] };
      }

      const worktrees: Array<{ path: string; head: string; branch: string | null; bare: boolean; detached: boolean }> = [];
      let current: { path?: string; head?: string; branch?: string | null; bare?: boolean; detached?: boolean } = {};
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          if (current.path) worktrees.push(current as { path: string; head: string; branch: string | null; bare: boolean; detached: boolean });
          current = { path: line.slice(9), head: "", branch: null, bare: false, detached: false };
        } else if (line.startsWith("HEAD ")) {
          current.head = line.slice(5);
        } else if (line.startsWith("branch ")) {
          current.branch = line.slice(7);
        } else if (line === "bare") {
          current.bare = true;
        } else if (line === "detached") {
          current.detached = true;
        }
      }
      if (current.path) worktrees.push(current as { path: string; head: string; branch: string | null; bare: boolean; detached: boolean });

      return { content: [{ type: "text", text: JSON.stringify({ success: true, worktrees }) }] };
    }

    case "get_diff": {
      const { working_dir, from_ref = "HEAD", to_ref } = args as { working_dir: string; from_ref?: string; to_ref?: string };
      const diffArgs = to_ref ? `${from_ref} ${to_ref}` : from_ref;
      const r = spawnSync("git", ["diff", ...diffArgs.split(" ")], { cwd: working_dir, encoding: "utf8" });
      return { content: [{ type: "text", text: JSON.stringify({ output: r.stdout + r.stderr, exit_code: r.status ?? -1 }) }] };
    }

    case "get_repo_state": {
      const { working_dir } = args as { working_dir: string };
      const run = (gitArgs: string[]) => spawnSync("git", gitArgs, { cwd: working_dir, encoding: "utf8" });

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

    default:
      return { content: [{ type: "text", text: `Unknown git tool: ${name}` }], isError: true };
  }
}
