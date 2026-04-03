import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import { withDbClient } from "./db.js";

function httpGetWithTimeout(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        try { resolve(JSON.parse(data) as Record<string, unknown>); }
        catch { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

async function fetchGitnexusContext(projectId: string): Promise<string> {
  if (!process.env.GITNEXUS_SERVICE_URL) return "";
  try {
    const githubOrg = process.env.GITHUB_ORG ?? "davidrfoote";
    const url = new URL(`/context/${githubOrg}/${projectId}`, process.env.GITNEXUS_SERVICE_URL);
    const res = await httpGetWithTimeout(url.toString(), 5000);
    if (res?.wiki_summary && typeof res.wiki_summary === "string") return res.wiki_summary;
  } catch {}
  return "";
}

function writeClaudeMd(worktreePath: string, sections: { projectId: string; branch: string | null; wikiSummary: string; cacheSummary: string; buildCmd: string | null }): void {
  const parts: string[] = [
    `# ${sections.projectId} — Agent Context`,
    ``,
    `**Branch:** ${sections.branch ?? "main"}`,
    `**Build:** \`${sections.buildCmd ?? "npm run build"}\``,
  ];
  if (sections.wikiSummary) {
    parts.push(``, `## Code Graph`, ``, sections.wikiSummary);
  }
  if (sections.cacheSummary) {
    parts.push(``, `## Project Context (Jira / Confluence)`, ``, sections.cacheSummary);
  }
  try {
    fs.writeFileSync(path.join(worktreePath, "CLAUDE.md"), parts.join("\n") + "\n");
  } catch (e: any) {
    console.warn(`[bootstrap] failed to write CLAUDE.md: ${e.message}`);
  }
}

// ─── Instruction builders ──────────────────────────────────────────────────

export async function buildBootstrapInstruction(sessionId: string, dbUrl: string): Promise<{ instruction: string; workingDir: string; allowedTools: string[] }> {
  const PORT = process.env.PORT ?? "9100";

  const data = await withDbClient(dbUrl, async (client) => {
    const sessionRes = await client.query<{
      project_id: string;
      jira_issue_keys: string[] | null;
      build_cmd: string | null;
      deploy_cmd: string | null;
      default_container: string | null;
      confluence_root_id: string | null;
      branch: string | null;
      worktree_path: string | null;
    }>(
      `SELECT s.project_id, s.jira_issue_keys, p.build_cmd, p.deploy_cmd, p.default_container, p.confluence_root_id, s.branch, s.worktree_path
       FROM sessions s LEFT JOIN projects p ON p.project_id = s.project_id
       WHERE s.session_id = $1`,
      [sessionId]
    );
    const briefRes = await client.query<{ content: string }>(
      `SELECT content FROM session_messages WHERE session_id=$1 AND message_type='task_brief' ORDER BY created_at LIMIT 1`,
      [sessionId]
    );
    return { session: sessionRes.rows[0] ?? null, brief: briefRes.rows[0]?.content ?? "(no brief)" };
  });

  const projectId = data.session?.project_id ?? "unknown";
  const jiraKeys = data.session?.jira_issue_keys ?? [];
  const sessionBranch = data.session?.branch ?? null;
  const sessionWorktreePath = data.session?.worktree_path ?? null;

  // Create worktree server-side and use it as workingDir (falls back to main repo if no worktree_path)
  let workingDir = `/home/david/${projectId}`;
  if (sessionWorktreePath && sessionBranch) {
    if (!fs.existsSync(sessionWorktreePath)) {
      fs.mkdirSync(path.dirname(sessionWorktreePath), { recursive: true });
      const repoPath = `/home/david/${projectId}`;
      const r = spawnSync("git", ["-C", repoPath, "worktree", "add", "-b", sessionBranch, sessionWorktreePath, "HEAD"], { encoding: "utf8" });
      if (r.status !== 0) {
        // Branch already exists — attach without -b
        spawnSync("git", ["-C", repoPath, "worktree", "add", sessionWorktreePath, sessionBranch], { encoding: "utf8" });
      }
    }
    workingDir = sessionWorktreePath;
  }

  // Read cache summaries
  const cacheKeys = [
    ...(data.session?.confluence_root_id ? [`confluence:${data.session.confluence_root_id}`] : []),
    ...jiraKeys.map((k) => `jira:${k}`),
  ];
  let cacheSummary = "";
  for (const key of cacheKeys) {
    try {
      const row = await withDbClient(dbUrl, async (client) => {
        const r = await client.query<{ summary: string }>(
          "SELECT summary FROM project_context_cache WHERE cache_key = $1",
          [key]
        );
        return r.rows[0] ?? null;
      });
      if (row?.summary) cacheSummary += `\n### ${key}\n${row.summary}\n`;
    } catch {}
  }

  // Fetch gitnexus code graph context (non-fatal)
  const wikiSummary = await fetchGitnexusContext(projectId);
  const codeGraphContext = wikiSummary ? `\n\n## Code Graph Context\n${wikiSummary}` : "";

  // Write CLAUDE.md into the worktree so the CLI agent picks it up automatically
  writeClaudeMd(workingDir, {
    projectId,
    branch: sessionBranch,
    wikiSummary,
    cacheSummary: cacheSummary.trim(),
    buildCmd: data.session?.build_cmd ?? null,
  });

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
    `- branch: ${sessionBranch ?? "main (no worktree)"}`,
    `- jira: ${jiraKeys.join(", ") || "none"}`,
    `- build: ${data.session?.build_cmd ?? "none"}`,
    ``,
    cacheSummary ? `### Cached Context (Jira/Confluence)\n${cacheSummary}` : "",
    codeGraphContext,
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

export async function buildExecutionInstruction(sessionId: string, dbUrl: string): Promise<{ instruction: string; workingDir: string; resumeClaudeSessionId?: string }> {
  const PORT = process.env.PORT ?? "9100";

  const data = await withDbClient(dbUrl, async (client) => {
    const sessionRes = await client.query<{
      project_id: string;
      jira_issue_keys: string[] | null;
      build_cmd: string | null;
      deploy_cmd: string | null;
      default_container: string | null;
      claude_session_id: string | null;
      branch: string | null;
      worktree_path: string | null;
    }>(
      `SELECT s.project_id, s.jira_issue_keys, p.build_cmd, p.deploy_cmd, p.default_container, s.claude_session_id, s.branch, s.worktree_path
       FROM sessions s LEFT JOIN projects p ON p.project_id = s.project_id
       WHERE s.session_id = $1`,
      [sessionId]
    );
    const planRes = await client.query<{ content: string }>(
      `SELECT content FROM session_messages WHERE session_id=$1 AND message_type='approval_request' AND role='coding_agent' ORDER BY created_at DESC LIMIT 1`,
      [sessionId]
    );
    const approvalRes = await client.query<{ content: string }>(
      `SELECT content FROM session_messages WHERE session_id=$1 AND message_type='approval_response' ORDER BY created_at DESC LIMIT 1`,
      [sessionId]
    );
    return {
      session: sessionRes.rows[0] ?? null,
      plan: planRes.rows[0]?.content ?? "(no plan found — implement based on the task brief)",
      approval: approvalRes.rows[0]?.content ?? "approved",
    };
  });

  const projectId = data.session?.project_id ?? "unknown";
  const jiraKeys = data.session?.jira_issue_keys ?? [];
  const primaryJira = jiraKeys[0] ?? "";
  const worktreePath = data.session?.worktree_path ?? null;
  const branch = data.session?.branch ?? null;
  const workingDir = worktreePath ?? `/home/david/${projectId}`;
  const resumeClaudeSessionId = data.session?.claude_session_id ?? undefined;

  // Refresh CLAUDE.md for the EXECUTION pass — gitnexus analysis may have completed since BOOTSTRAP
  const wikiSummary = await fetchGitnexusContext(projectId);
  {
    // Always rewrite — even without wiki, cache summaries are valuable
    const cacheKeys = [
      ...jiraKeys.map((k) => `jira:${k}`),
    ];
    let execCacheSummary = "";
    for (const key of cacheKeys) {
      try {
        const row = await withDbClient(dbUrl, async (client) => {
          const r = await client.query<{ summary: string }>(
            "SELECT summary FROM project_context_cache WHERE cache_key = $1",
            [key]
          );
          return r.rows[0] ?? null;
        });
        if (row?.summary) execCacheSummary += `\n### ${key}\n${row.summary}\n`;
      } catch {}
    }
    writeClaudeMd(workingDir, {
      projectId,
      branch,
      wikiSummary,
      cacheSummary: execCacheSummary.trim(),
      buildCmd: data.session?.build_cmd ?? null,
    });
  }

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
    `- branch: ${branch ?? "main (no worktree)"}`,
    `- jira: ${jiraKeys.join(", ") || "none"}`,
    `- build: ${data.session?.build_cmd ?? "none"}`,
    `- deploy: ${data.session?.deploy_cmd ?? "none"}`,
    ``,
    `### Instructions`,
    branch
      ? `1. You are already on branch \`${branch}\` in the worktree at \`${workingDir}\`. Do NOT create another branch.`
      : `1. Create a feature branch: \`git checkout -b feature/${primaryJira || "dev"}-<short-description>\``,
    `2. Implement the approved plan`,
    `3. Run the build and fix any errors: \`${data.session?.build_cmd ?? "npm run build"}\``,
    `4. Commit with message: "${primaryJira ? primaryJira + ": " : ""}<description>"`,
    branch
      ? `5. Push the branch: \`git push origin ${branch}\``
      : `5. Push the feature branch: \`git push origin feature/${primaryJira || "dev"}-<short-description>\``,
    `6. When fully done, post a checkpoint via (include branch name and git SHA):`,
    ``,
    `\`\`\`bash`,
    `BRANCH="feature/${primaryJira || "dev"}-<short-description>"`,
    `SHA=$(git rev-parse HEAD)`,
    `SUMMARY="<what was changed, which files>. Branch: $BRANCH. SHA: $SHA"`,
    `curl -s -X POST http://localhost:${PORT}/session/${sessionId}/message \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d "{\\"role\\":\\"coding_agent\\",\\"message_type\\":\\"checkpoint\\",\\"content\\":\\"$SUMMARY\\"}"`,
    `\`\`\``,
    ``,
    `7. Exit after posting the checkpoint.`,
  ].filter(Boolean).join("\n");

  return { instruction, workingDir, resumeClaudeSessionId };
}

export async function buildCloseoutMessage(sessionId: string, checkpointContent: string, dbUrl: string): Promise<string> {
  const fallback = `SESSION_ID: ${sessionId}\nROLE: close-out\nCHECKPOINT: ${checkpointContent}\n\nYou are dev-lead performing session close-out. Read AGENTS.md at /home/openclaw/agents/dev-lead/AGENTS.md.`;
  try {
    const config = await withDbClient(dbUrl, async (client) => {
      const r = await client.query<{
        project_id: string;
        jira_issue_keys: string[] | null;
        build_cmd: string | null;
        deploy_cmd: string | null;
        smoke_url: string | null;
        default_container: string | null;
        gateway_parent_key: string | null;
      }>(
        `SELECT s.project_id, s.jira_issue_keys, p.build_cmd, p.deploy_cmd, p.smoke_url, p.default_container, s.gateway_parent_key
         FROM sessions s LEFT JOIN projects p ON p.project_id = s.project_id
         WHERE s.session_id = $1`,
        [sessionId]
      );
      return r.rows[0] ?? null;
    });
    if (!config) return fallback;
    return [
      `SESSION_ID: ${sessionId}`,
      `ROLE: close-out`,
      `CHECKPOINT: ${checkpointContent.slice(0, 1000)}`,
      `PROJECT: ${config.project_id}`,
      `JIRA_KEYS: ${config.jira_issue_keys?.join(",") ?? "none"}`,
      `BUILD: ${config.build_cmd ?? "none"}`,
      `DEPLOY: ${config.deploy_cmd ?? "none"}`,
      `SMOKE: ${config.smoke_url ?? "none"}`,
      `ASH_SESSION_KEY: ${config.gateway_parent_key ?? process.env.OPENCLAW_SESSION_KEY ?? ""}`,
      ``,
      `You are dev-lead. The coding agent has finished. Your job is close-out only.`,
      `Read /home/openclaw/agents/dev-lead/AGENTS.md for the full procedure.`,
      `Steps: verify git SHA → push feature branch → create PR via Atlassian Bitbucket MCP → Jira to In Review → WIP Confluence page → mark session pending_review → notify Ash with PR link.`,
    ].join("\n");
  } catch {
    return fallback;
  }
}

// ─── Project resolution ────────────────────────────────────────────────────

export async function resolveProject(
  dbUrl: string,
  projectId?: string,
  projectHint?: string
): Promise<{
  project_id: string | null;
  available_projects: Array<{ project_id: string; display_name: string | null; description: string | null }>;
}> {
  return withDbClient(dbUrl, async (client) => {
    const res = await client.query<{
      project_id: string;
      display_name: string | null;
      description: string | null;
    }>(`SELECT project_id, display_name, description FROM projects ORDER BY updated_at DESC`);

    const available_projects = res.rows;

    if (projectId) {
      const exact = available_projects.find((r) => r.project_id === projectId);
      if (exact) return { project_id: exact.project_id, available_projects };
    }

    if (projectHint) {
      const hint = projectHint.toLowerCase();
      const match = available_projects.find(
        (r) => r.project_id.toLowerCase() === hint || (r.display_name ?? "").toLowerCase() === hint
      );
      if (match) return { project_id: match.project_id, available_projects };
    }

    return { project_id: null, available_projects };
  });
}

export async function ensureProject(
  dbUrl: string,
  projectId: string,
  displayName?: string,
  description?: string
): Promise<void> {
  await withDbClient(dbUrl, async (client) => {
    let workingDir: string | null = null;
    for (const candidate of [`/home/david/${projectId}`, `/home/openclaw/apps/${projectId}`, `/opt/${projectId}`]) {
      if (fs.existsSync(candidate)) { workingDir = candidate; break; }
    }

    let buildCmd: string | null = null;
    let deployCmd: string | null = null;
    if (workingDir) {
      if (fs.existsSync(path.join(workingDir, "swarm.yml"))) {
        buildCmd = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
        deployCmd = `docker stack deploy -c ${workingDir}/swarm.yml ${projectId}`;
      } else if (fs.existsSync(path.join(workingDir, "Dockerfile"))) {
        buildCmd = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
        deployCmd = `docker service update --image ${projectId}:latest prod_${projectId} || docker service update --image ${projectId}:latest ${projectId}`;
      } else if (fs.existsSync(path.join(workingDir, "package.json"))) {
        buildCmd = `cd ${workingDir} && npm install && npm run build`;
        deployCmd = `pkill -f "node dist/index.js" 2>/dev/null || true; nohup node ${workingDir}/dist/index.js > /tmp/${projectId}.log 2>&1 &`;
      }
    }

    await client.query(
      `INSERT INTO projects (project_id, display_name, description, working_dir, default_container, build_cmd, deploy_cmd, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
       ON CONFLICT (project_id) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, projects.display_name),
         description = COALESCE(EXCLUDED.description, projects.description),
         updated_at = now()`,
      [projectId, displayName || null, description || null, workingDir, "dev-david", buildCmd, deployCmd]
    );
  });
}
