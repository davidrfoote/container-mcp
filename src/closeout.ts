import { withDbClient } from "./db.js";
import { postToFeed } from "./feed.js";
import { logger } from "./logger.js";

interface SessionCloseoutInfo {
  project_id: string;
  branch: string | null;
  jira_issue_keys: string[] | null;
  title: string | null;
  github_repo: string | null;
}

async function fetchCloseoutInfo(sessionId: string, dbUrl: string): Promise<SessionCloseoutInfo | null> {
  return withDbClient(dbUrl, async (client) => {
    const res = await client.query<SessionCloseoutInfo>(
      `SELECT s.project_id, s.branch, s.jira_issue_keys, s.title,
              p.github_repo
       FROM sessions s
       LEFT JOIN projects p ON p.project_id = s.project_id
       WHERE s.session_id = $1`,
      [sessionId]
    );
    return res.rows[0] ?? null;
  });
}

async function createPullRequest(params: {
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  token: string;
}): Promise<{ number: number; html_url: string } | null> {
  const { owner, repo, branch, baseBranch, title, body, token } = params;
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ title, body, head: branch, base: baseBranch }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    // 422 with "A pull request already exists" is not a real error
    if (resp.status === 422 && text.includes("A pull request already exists")) {
      logger.warn(`[closeout] PR already exists for ${branch} — skipping creation`);
      return null;
    }
    throw new Error(`GitHub PR creation failed: ${resp.status} ${text.slice(0, 300)}`);
  }

  const data = await resp.json() as { number: number; html_url: string };
  return data;
}

async function mergeSquash(params: {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
}): Promise<boolean> {
  const { owner, repo, prNumber, token } = params;
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`;

  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ merge_method: "squash" }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.warn(`[closeout] Auto-merge failed for PR #${prNumber}: ${resp.status} ${text.slice(0, 200)}`);
    return false;
  }

  return true;
}

export async function runCloseout(
  sessionId: string,
  checkpointContent: string,
  dbUrl: string
): Promise<void> {
  logger.log(`[closeout] starting for session ${sessionId}`);

  const token = process.env.GITHUB_TOKEN;

  // ── 1. Fetch session + project info ──────────────────────────────────────
  let info: SessionCloseoutInfo | null = null;
  try {
    info = await fetchCloseoutInfo(sessionId, dbUrl);
  } catch (e: any) {
    logger.error(`[closeout] DB query failed for ${sessionId}:`, e.message);
  }

  if (!info) {
    logger.warn(`[closeout] no session info found for ${sessionId} — still marking pending_review`);
    await markPendingReview(sessionId, dbUrl);
    return;
  }

  const { project_id: projectId, branch, jira_issue_keys: jiraKeys, title, github_repo: githubRepoOverride } = info;

  // ── 2. Determine GitHub owner/repo ───────────────────────────────────────
  const ownerDefault = process.env.GITHUB_REPO_OWNER ?? "davidrfoote";
  const ownerRepo = githubRepoOverride ?? `${ownerDefault}/${projectId}`;
  const [owner, repo] = ownerRepo.split("/");
  const baseBranch = process.env.GITHUB_BASE_BRANCH ?? "main";

  // ── 3. Create PR (only if we have branch + token) ────────────────────────
  let prUrl: string | null = null;

  if (!token) {
    logger.warn(`[closeout] GITHUB_TOKEN not set — skipping PR creation for ${sessionId}`);
  } else if (!branch) {
    logger.warn(`[closeout] session ${sessionId} has no branch — skipping PR creation`);
  } else {
    const jiraPrefix = jiraKeys && jiraKeys.length > 0 ? `[${jiraKeys[0]}] ` : "";
    const prTitle = `${jiraPrefix}${title ?? checkpointContent.slice(0, 80)}`;
    const sessionUrl = `https://dev-sessions.ash.zennya.app/sessions/${sessionId}`;
    const prBody = [
      `## Session\n[${sessionId}](${sessionUrl})`,
      `## Summary\n${checkpointContent.slice(0, 1000)}`,
      jiraKeys && jiraKeys.length > 0 ? `## Jira\n${jiraKeys.join(", ")}` : null,
    ].filter(Boolean).join("\n\n");

    try {
      const pr = await createPullRequest({ owner, repo, branch, baseBranch, title: prTitle, body: prBody, token });
      if (pr) {
        prUrl = pr.html_url;
        logger.log(`[closeout] PR created: ${prUrl} (#${pr.number})`);

        // ── 4. Attempt auto-merge ─────────────────────────────────────────
        const merged = await mergeSquash({ owner, repo, prNumber: pr.number, token });
        if (merged) {
          logger.log(`[closeout] PR #${pr.number} auto-merged (squash) for ${sessionId}`);
        }
      }
    } catch (e: any) {
      logger.error(`[closeout] PR/merge error for ${sessionId}:`, e.message);
      // Non-fatal — continue to mark pending_review
    }
  }

  // ── 5. Mark session pending_review ───────────────────────────────────────
  await markPendingReview(sessionId, dbUrl);

  // ── 6. Post to feed ───────────────────────────────────────────────────────
  const feedMsg = prUrl
    ? `✅ Close-out complete. PR: ${prUrl}`
    : `✅ Close-out complete (no PR created). Session marked pending_review.`;
  postToFeed(sessionId, dbUrl, feedMsg);

  logger.log(`[closeout] done for session ${sessionId}${prUrl ? ` — PR: ${prUrl}` : ""}`);
}

async function markPendingReview(sessionId: string, dbUrl: string): Promise<void> {
  try {
    await withDbClient(dbUrl, async (client) => {
      await client.query(
        `UPDATE sessions SET status = 'pending_review', updated_at = now() WHERE session_id = $1`,
        [sessionId]
      );
    });
    logger.log(`[closeout] session ${sessionId} marked pending_review`);
  } catch (e: any) {
    logger.error(`[closeout] failed to mark pending_review for ${sessionId}:`, e.message);
  }
}
