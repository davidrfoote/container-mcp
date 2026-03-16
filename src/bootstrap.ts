import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import { withDbClient } from "./db.js";
import { postToFeed } from "./feed.js";
import { spawnCodeTask } from "./code-task.js";
import { populateCacheForProject, searchJiraForIssue, createJiraTaskIssue } from "./jira-confluence.js";

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

const SLACK_USER_MAP: Record<string, string> = {
  U097Q46UX: "David",
  U160P0C7M: "Shane",
  U1AT2UF9V: "Jan",
};

// ─── Instruction builders ──────────────────────────────────────────────────

export async function buildBootstrapInstruction(sessionId: string, dbUrl: string): Promise<{ instruction: string; workingDir: string; allowedTools: string[] }> {
  const PORT = process.env.PORT ?? "9000";

  const data = await withDbClient(dbUrl, async (client) => {
    const sessionRes = await client.query<{
      project_id: string;
      jira_issue_keys: string[] | null;
      build_cmd: string | null;
      deploy_cmd: string | null;
      default_container: string | null;
      confluence_root_id: string | null;
    }>(
      `SELECT s.project_id, s.jira_issue_keys, p.build_cmd, p.deploy_cmd, p.default_container, p.confluence_root_id
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
  let codeGraphContext = "";
  try {
    if (process.env.GITNEXUS_SERVICE_URL) {
      const url = new URL(`/context/${path.basename(workingDir)}`, process.env.GITNEXUS_SERVICE_URL);
      const res = await httpGetWithTimeout(url.toString(), 5000);
      if (res?.wiki_summary) codeGraphContext = `\n\n## Code Graph Context\n${res.wiki_summary}`;
    }
  } catch {}

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
  const PORT = process.env.PORT ?? "9000";

  const data = await withDbClient(dbUrl, async (client) => {
    const sessionRes = await client.query<{
      project_id: string;
      jira_issue_keys: string[] | null;
      build_cmd: string | null;
      deploy_cmd: string | null;
      default_container: string | null;
      claude_session_id: string | null;
    }>(
      `SELECT s.project_id, s.jira_issue_keys, p.build_cmd, p.deploy_cmd, p.default_container, s.claude_session_id
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
    `3. Run the build and fix any errors: \`${data.session?.build_cmd ?? "npm run build"}\``,
    `4. Commit with message: "${primaryJira ? primaryJira + ": " : ""}<description>"`,
    `5. Push the feature branch: \`git push origin feature/${primaryJira || "dev"}-<short-description>\``,
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
      }>(
        `SELECT s.project_id, s.jira_issue_keys, p.build_cmd, p.deploy_cmd, p.smoke_url, p.default_container
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

// ─── bootstrapSession orchestrator ─────────────────────────────────────────

export async function bootstrapSession(params: {
  user_request: string;
  user_id: string;
  project_id?: string;
  project_hint?: string;
  display_name?: string;
  description?: string;
  slack_thread_url?: string;
}): Promise<{
  ok: boolean;
  session_id?: string;
  session_url?: string;
  error?: string;
  needs_project?: boolean;
  available_projects?: Array<{ project_id: string; display_name: string | null; description: string | null }>;
}> {
  const { user_request, user_id, project_id, project_hint, display_name, description, slack_thread_url } = params;
  const triggeredByName = SLACK_USER_MAP[user_id] ?? user_id;
  const triggeredBySlackUserId = user_id;
  const dbUrl = process.env.OPS_DB_URL;
  if (!dbUrl) return { ok: false, error: "OPS_DB_URL not set" };

  // Step 1: Resolve project
  let projectId: string | null = null;

  // Guard: reject project_id values that look like user IDs (e.g. Slack "U097Q46UX")
  if (project_id && /^[A-Z][A-Z0-9]{5,}$/.test(project_id)) {
    return { ok: false, error: `project_id "${project_id}" looks like a user ID, not a project identifier. Project IDs should be lowercase kebab-case (e.g. "my-api", "ash-dashboard").` };
  }

  try {
    const resolved = await resolveProject(dbUrl, project_id, project_hint);
    projectId = resolved.project_id;

    if (!projectId) {
      if (project_id) {
        console.log(`[bootstrapSession] Auto-creating project: ${project_id}`);
        await ensureProject(dbUrl, project_id, display_name, description);
        projectId = project_id;
      } else {
        console.log(`[bootstrapSession] No project matched, returning ${resolved.available_projects.length} projects for caller`);
        return {
          ok: false,
          needs_project: true,
          available_projects: resolved.available_projects,
          error: `Could not match a project. Please call again with an explicit project_id (pick from available_projects, or provide a new one to auto-create it).`,
        };
      }
    }
    console.log(`[bootstrapSession] resolved project: ${projectId}`);
  } catch (e: any) {
    return { ok: false, error: `Project lookup failed: ${e.message}` };
  }

  // Steps 2-3: Check for existing active session
  try {
    const existing = await withDbClient(dbUrl, async (client) => {
      const r = await client.query<{ session_id: string }>(
        `SELECT session_id FROM sessions WHERE user_id = $1 AND project_id = $2 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
        [user_id, projectId]
      );
      return r.rows[0] ?? null;
    });
    if (existing) {
      const sessionUrl = `https://dev-sessions.ash.zennya.app/sessions/${existing.session_id}`;
      console.log(`[bootstrapSession] returning existing session ${existing.session_id}`);
      return { ok: true, session_id: existing.session_id, session_url: sessionUrl };
    }
  } catch (e: any) {
    return { ok: false, error: `Session check failed: ${e.message}` };
  }

  // Step 4: Fetch project config
  let projConfig: {
    display_name: string | null;
    description: string | null;
    default_container: string | null;
    jira_issue_keys: string[] | null;
    confluence_root_id: string | null;
  } | null = null;
  try {
    projConfig = await withDbClient(dbUrl, async (client) => {
      const r = await client.query<{
        display_name: string | null;
        description: string | null;
        default_container: string | null;
        jira_issue_keys: string[] | null;
        confluence_root_id: string | null;
      }>(
        `SELECT display_name, description, default_container, jira_issue_keys, confluence_root_id FROM projects WHERE project_id = $1`,
        [projectId]
      );
      return r.rows[0] ?? null;
    });
  } catch (e: any) {
    return { ok: false, error: `Project config fetch failed: ${e.message}` };
  }
  if (!projConfig) return { ok: false, error: `Project not found: ${projectId}` };

  // Step 6: Search Jira for parent issue or create task issue
  const existingKeys = projConfig.jira_issue_keys ?? [];
  let jiraIssueKey: string | null = null;
  if (existingKeys.length > 0) {
    const projectKey = existingKeys[0].split("-")[0];
    const keywords = user_request.replace(/['"\\]/g, "").slice(0, 80);
    jiraIssueKey = await searchJiraForIssue(projectKey, keywords);
    if (!jiraIssueKey) {
      jiraIssueKey = await createJiraTaskIssue(projectKey, user_request.slice(0, 100), user_request);
    }
    if (jiraIssueKey) console.log(`[bootstrapSession] Jira issue: ${jiraIssueKey}`);
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
    : `sess-${randomUUID().slice(0, 8)}-${ts}`;
  const sessionUrl = `https://dev-sessions.ash.zennya.app/sessions/${sessionId}`;
  const jiraKeysArr = allJiraKeys.length > 0 ? `{${allJiraKeys.join(",")}}` : null;

  try {
    await withDbClient(dbUrl, async (client) => {
      await client.query(
        `INSERT INTO sessions (session_id, project_id, container, repo, status, session_type, title, prompt_preview, jira_issue_keys, user_id, triggered_by_name, triggered_by_slack_user_id, slack_thread_url, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', 'dev', $5, $6, $7::text[], $8, $9, $10, $11, now(), now())`,
        [sessionId, projectId, projConfig!.default_container ?? "dev-david", projectId,
          user_request.slice(0, 100), taskBrief.slice(0, 500), jiraKeysArr, user_id,
          triggeredByName, triggeredBySlackUserId, slack_thread_url ?? null]
      );
      const msgId = `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      await client.query(
        `INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
         VALUES ($1, $2, 'user', $3, 'task_brief', now())`,
        [msgId, sessionId, taskBrief]
      );
    });
  } catch (e: any) {
    return { ok: false, error: `Session creation failed: ${e.message}` };
  }

  // Step 5: Warm cache (non-fatal on failure)
  try {
    console.log(`[bootstrapSession] Starting cache warm for projectId=${projectId}, confluenceRootId=${projConfig.confluence_root_id}`);
    await populateCacheForProject(dbUrl, projConfig.jira_issue_keys ?? [], projConfig.confluence_root_id ?? null);
    console.log(`[bootstrapSession] cache warmed successfully for ${projectId}`);
    await withDbClient(dbUrl, async (client) => {
      await client.query(
        'INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4)',
        [sessionId, 'dev_lead', '[CACHE-SUCCESS] Warmup complete for ' + projectId, 'console']
      );
    }).catch(() => {});
  } catch (e: any) {
    console.warn(`[bootstrapSession] cache warm failed (non-fatal): ${e.message}`);
    await withDbClient(dbUrl, async (client) => {
      await client.query(
        'INSERT INTO session_messages (message_id, session_id, role, content, message_type) VALUES (gen_random_uuid(), $1, $2, $3, $4)',
        [sessionId, 'dev_lead', '[CACHE-FAILED] ' + e.message, 'console']
      );
    }).catch(() => {});
  }

  // Spawn BOOTSTRAP code task (non-fatal on failure)
  try {
    const { instruction, workingDir, allowedTools } = await buildBootstrapInstruction(sessionId, dbUrl);
    spawnCodeTask({ instruction, workingDir, sessionId, dbUrl, allowedTools });
    console.log(`[bootstrapSession] BOOTSTRAP code task spawned for session ${sessionId}`);
    await withDbClient(dbUrl, async (client) => {
      await client.query("UPDATE sessions SET status = 'active', updated_at = now() WHERE session_id = $1", [sessionId]);
    }).catch((e: any) => console.warn('[bootstrapSession] failed to set status=active: ' + e.message));
  } catch (e: any) {
    console.warn(`[bootstrapSession] BOOTSTRAP spawn error (non-fatal): ${e.message}`);
    await withDbClient(dbUrl, async (client) => {
      await client.query(
        `INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at)
         VALUES (gen_random_uuid(), $1, 'system', $2, 'console', now())`,
        [sessionId, `⚠️ Session created but BOOTSTRAP spawn failed: ${e.message}`]
      );
    }).catch(() => {});
  }

  console.log(`[bootstrapSession] created session ${sessionId} for user ${user_id} / project ${projectId}`);
  return { ok: true, session_id: sessionId, session_url: sessionUrl };
}
