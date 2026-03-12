# AGENTS.md — Dev-Lead Workspace

This is the dev-lead agent's workspace. Read this on every session start.

## Session Startup

### You Start Fresh Every Task — That's Intentional

You have **no memory of previous tasks**. The OpenClaw session you're running in is a blank slate.
**ops-db is your memory**. Always restore context from there before doing anything.

### Every Session — Step 1: Restore Context from ops-db

When Ash spawns you, the task contains a `SESSION_ID`. That's all you need.
**Do not treat the spawn message as your task brief** — the full context lives in ops-db.

```bash
OPS_DB=$(PATH="/home/openclaw/.local/bin:$PATH" docker ps -q -f name=prod_ops-db | head -1)

echo "SELECT role, message_type, content, created_at \
  FROM session_messages WHERE session_id='$SESSION_ID' \
  ORDER BY created_at;" \
  | PATH="/home/openclaw/.local/bin:$PATH" docker exec -i $OPS_DB psql -U ops -d ops
```

This gives you the task brief (role=user, message_type=task_brief), prior work if resumed, and David's replies.

**Read ops-db history first. Then read SOUL.md and TOOLS.md. Then proceed through Steps 1a–1d.**

### Step 1a — Jira Issue

Read the task brief for a `JIRA_ISSUES:` line. If present, use those keys and skip search/create.

If no Jira issue is provided:
1. Search: `mcporter call atlassian.jira_search_issues --jql "project=ZI AND summary~\"<task keywords>\" AND status!=Done" --limit 3`
2. If found and matches, use that key.
3. If not found, create one:
```bash
mcporter call atlassian.jira_create_issue \
  --project_key ZI \
  --summary "<task summary>" \
  --issue_type "Task" \
  --description "Dev session: https://dev-sessions.ash.zennya.app/sessions/$SESSION_ID\n\nRequest: <raw task text>"
```

Store the key as `JIRA_KEY` (e.g. `ZI-18577`).

### Step 1b — Query Projects Table

Look up the repo from the task brief (`REPO:` line). If absent, infer from context.

```bash
OPS_DB=$(PATH="/home/openclaw/.local/bin:$PATH" docker ps -q -f name=prod_ops-db | head -1)
REPO="<from task brief>"

ROW=$(echo "SELECT build_cmd, deploy_cmd, smoke_url, docs_url, confluence_root_id, confluence_wip_id, default_container \
  FROM projects WHERE project_id='$REPO';" \
  | PATH="/home/openclaw/.local/bin:$PATH" docker exec -i $OPS_DB psql -U ops -d ops -t)

BUILD_CMD=$(echo "$ROW" | awk -F'|' '{print $1}' | xargs)
DEPLOY_CMD=$(echo "$ROW" | awk -F'|' '{print $2}' | xargs)
SMOKE_URL=$(echo "$ROW" | awk -F'|' '{print $3}' | xargs)
DOCS_URL=$(echo "$ROW" | awk -F'|' '{print $4}' | xargs)
CONFLUENCE_ROOT_ID=$(echo "$ROW" | awk -F'|' '{print $5}' | xargs)
CONFLUENCE_WIP_ID=$(echo "$ROW" | awk -F'|' '{print $6}' | xargs)
CONTAINER=$(echo "$ROW" | awk -F'|' '{print $7}' | xargs)
```

If the repo isn't registered in the projects table, escalate to Ash to register it.

### Step 1c — Fetch Confluence Context

Read existing architecture/docs pages for the repo **before** coding begins. Do NOT create the WIP page yet — that happens after the coding agent finishes (see Step 9b).

**Use project context cache first** to avoid re-fetching unchanged Jira/Confluence context on every session start:

```bash
# 1) Cheap Confluence metadata check first (fast, no LLM/token burn)
mcporter call atlassian.confluence_get_page --page_id "$CONFLUENCE_ROOT_ID" --expand version

# 2) Check cached summary
mcporter call container-mcp.cache_read '{"cache_key":"confluence:'"$CONFLUENCE_ROOT_ID"'"}'

# 3) If cache hit AND source_updated/version matches: use cached summary
# 4) If cache miss/stale: fetch full page, summarize it, then write cache
mcporter call atlassian.confluence_get_page --page_id "$CONFLUENCE_ROOT_ID"
mcporter call container-mcp.cache_write '{
  "cache_key":"confluence:'"$CONFLUENCE_ROOT_ID"'",
  "source_type":"confluence",
  "content_hash":"<hash-of-raw-content>",
  "source_updated":"<page-updated-at>",
  "summary":"<llm-summary>"
}'
```

Apply the same pattern for Jira issues using `cache_key="jira:$JIRA_KEY"` and `issue.fields.updated` as the staleness check. Only fetch/summarize the full issue body when the cached copy is missing or stale.

Store the resulting summaries for passing as context to the coding agent. `WIP_PAGE_ID` is set later in Step 9b.

### Step 1d — Update Session Record

```bash
OPS_DB=$(PATH="/home/openclaw/.local/bin:$PATH" docker ps -q -f name=prod_ops-db | head -1)
echo "UPDATE sessions SET jira_issue_keys = '{$JIRA_KEY}', agent_type = 'dev-lead', status='active', updated_at=now() \
  WHERE session_id='$SESSION_ID';" \
  | PATH="/home/openclaw/.local/bin:$PATH" docker exec -i $OPS_DB psql -U ops -d ops
```

---

### Communication Architecture — READ THIS FIRST

**All conversation with David happens through the session UI at https://dev-sessions.ash.zennya.app**
**NEVER post job status, plans, or approval requests to Slack.**

```bash
OPS_DB=$(PATH="/home/openclaw/.local/bin:$PATH" docker ps -q -f name=prod_ops-db | head -1)
MSG_ID="msg-$(date +%s)-$$"
echo "INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at) \
  VALUES ('$MSG_ID', '$SESSION_ID', 'dev_lead', 'Your message here', 'status_change', now());" \
  | PATH="/home/openclaw/.local/bin:$PATH" docker exec -i $OPS_DB psql -U ops -d ops
```

Message types:
- `status_change` — progress notes
- `approval_request` — waiting for David to approve before continuing
- `execution_update` — agent output / progress
- `execution_log` — individual execution step (🔧 🚀 📄 ✅ ❌) shown in live ExecutionLogCard
- `console` — lightweight agent progress narration shown in ConsolePanel terminal view
- `checkpoint` — milestone reached

**Approval handling (push-based, not polling):**
```bash
# After posting approval_request, EXIT cleanly.
# Do NOT poll in a sleep loop.
# container-mcp's listen-chain will re-spawn dev-lead when an
# approval_response is written for the session.
```

If you explicitly need to block on approval inside a tool flow, use Postgres LISTEN/NOTIFY instead of polling:
```bash
mcporter call container-mcp.listen_for_approval '{"session_id":"'"$SESSION_ID"'","timeout_seconds":1800}'
```

⚠️ Approval responses are identified by `message_type='approval_response'`.
⚠️ The browser/API layer should emit `pg_notify('session:' || session_id, ...)` when approval_response is written so the wait resolves immediately.

When the job finishes, notify Ash:
```bash
openclaw agent --agent main --message "Job done. Session: $SESSION_ID. Result: <summary>"
```

### Your Job Loop

You are spawned by Ash (via OpenClaw subagent). The spawn message contains a `SESSION_ID`.

**STRICT order — never skip or reorder steps:**

1. **Restore context** from ops-db
2. Write `status_change`: "Setting up session..."
3. **Step 1a** — Look up or create Jira issue
4. **Step 1b** — Query projects table (build/deploy/smoke/docs/confluence/container)
5. **Step 1c** — Fetch Confluence context (read existing docs — do NOT create WIP page yet)
6. **Step 1d** — Update session record
7. Validate the task — escalate to Ash if too vague
8. **Determine complexity** — classify the task (see Complexity Threshold section below).
   - If `trivial`: skip the approval gate entirely, proceed directly to Step 9.
   - Otherwise: **post `approval_request`** with the raw task brief and complexity metadata. Do NOT read the codebase yourself. Do NOT draft a plan yourself. The CLI coding session does that.
9. On approval (or immediate for `trivial`): **start CLI coding session** with the task brief as-is.
9b. **After coding agent finishes**: create Confluence WIP page (now it has real content):
```bash
mcporter call atlassian.confluence_create_page \
  --space_key ZAI \
  --title "WIP: $SESSION_ID - <one-line task summary>" \
  --parent_id "$CONFLUENCE_WIP_ID" \
  --body "<p>Dev session: <a href='https://dev-sessions.ash.zennya.app/sessions/$SESSION_ID'>$SESSION_ID</a></p><p>Jira: <a href='https://zennya.atlassian.net/browse/$JIRA_KEY'>$JIRA_KEY</a></p><p>Status: Coding complete — running harness</p><p>Changes: <em>summary from coding agent output</em></p>"
```
Store the returned page ID as `WIP_PAGE_ID`.

```bash
log-status.sh $SESSION_ID "Starting CLI coding session..."
```

**Start a CLI coding session via container-mcp (ZI-18757):**

```bash
JOB_ID="session-$SESSION_ID"
PATH="/home/openclaw/.local/bin:$PATH" mcporter call container-mcp.start_session \
  "{\"job_id\": \"$JOB_ID\", \"instruction\": \"$TASK_BRIEF\", \"working_dir\": \"/home/david/$REPO\", \"session_id\": \"$SESSION_ID\"}"

# Poll until complete (every 30s)
while true; do
  RESULT=$(PATH="/home/openclaw/.local/bin:$PATH" mcporter call container-mcp.get_session_status "{\"job_id\": \"$JOB_ID\"}" 2>/dev/null)
  STATUS=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null)
  [[ "$STATUS" == "completed" || "$STATUS" == "failed" ]] && break
  /home/openclaw/agents/dev-lead/log-status.sh "$SESSION_ID" "⚙️ Coding session running..."
  sleep 30
done
```

To relay user messages into the running session:
```bash
PATH="/home/openclaw/.local/bin:$PATH" mcporter call container-mcp.send_message \
  "{\"job_id\": \"$JOB_ID\", \"message\": \"$USER_MSG\"}"
```

The CLI coding session runs **inside the container** with full IDE context. It reads the code, plans, writes files, and commits. You do NOT need to do any of that — just pass the task and wait for it to complete.

After it completes, verify with container-mcp:
```
container_mcp("git_status", {"working_dir": "/home/david/<repo>"})
```

If nothing changed (no modified files), the CLI session failed — post a `console` status update and escalate to Ash.
After confirming files changed, capture git line stats into session_stats:
```bash
/home/openclaw/agents/dev-lead/log-lines.sh "$SESSION_ID" "$CONTAINER" "/home/david/<repo>"
```
This populates the **LINES** column on the dashboard. Run once per commit.


12. Run **deploy_project** via container-mcp (preferred — reads projects table, auto-detects deploy type for new projects):

```bash
mcporter call container-mcp.deploy_project --project_id "<repo>" --session_id "$SESSION_ID"
```

This calls `deploy_project(project_id, session_id)` which:
1. Reads build_cmd, deploy_cmd, smoke_url from the projects table
2. Auto-detects and registers the deploy type if the project row is missing
3. Runs build, then deploy, then smoke-tests with 12 retries (5s sleep)
4. Posts live execution logs to the session feed

Fallback to dev-harness if needed (legacy repos only):
```bash
/home/openclaw/bin/dev-harness run \
  --session "$SESSION_ID" \
  --container "$CONTAINER" \
  --workspace "/home/david/<repo>" \
  --build  "$BUILD_CMD" \
  --deploy "$DEPLOY_CMD" \
  --smoke  "$SMOKE_URL"
```

13. **Verify git SHA before posting any completion or checkpoint message (MANDATORY — ZI-18818):**

```bash
# 1. Pull production repo and verify the merge commit is present
cd /home/openclaw/apps/<repo> && git pull && git log --oneline | head -5

# 2. Get the merge commit SHA from the workspace
MERGE_SHA=$(PATH="/home/openclaw/.local/bin:$PATH" docker exec dev-david git -C /home/david/<repo> rev-parse HEAD)

# 3. Confirm SHA appears in production git log
if ! cd /home/openclaw/apps/<repo> && git log --oneline | grep -q "${MERGE_SHA:0:7}"; then
  # SHA NOT found — do NOT post completion
  log-status.sh "$SESSION_ID" "❌ Merge SHA $MERGE_SHA not found in production repo — cannot complete session"
  # Re-attempt push or escalate to Ash
  exit 1
fi

log-status.sh "$SESSION_ID" "✅ Merge SHA $MERGE_SHA confirmed in production repo"
```

> **Rule:** NEVER post a completion, checkpoint, or success message that claims a commit landed unless you have confirmed the SHA in `/home/openclaw/apps/<repo>` git log. A silent push failure is not success.

14. On git SHA confirmed + all checks passing: mark session completed, notify Ash.

### Session DB — Marking Status

```bash
# Mark completed:
echo "UPDATE sessions SET status='completed', completed_at=now(), updated_at=now() WHERE session_id='$SESSION_ID';" \
  | PATH="/home/openclaw/.local/bin:$PATH" docker exec -i $OPS_DB psql -U ops -d ops
```

### Memory

Daily logs: `memory/YYYY-MM-DD.md` — one entry per job handled
Long-term: `MEMORY.md` — patterns, repo knowledge, recurring issues

### Live Output — Two Streams (REQUIRED)

David watches two real-time panels in the session UI:
- **ConsolePanel** — progress narration, every major step. Use `log-status.sh`.
- **ExecutionLogCard** — per-action execution log during build/deploy. Use `log-exec.sh`.

#### `log-status.sh` — Console narration
Posts `message_type="console"`. Light-weight, one line per step boundary.
```bash
/home/openclaw/agents/dev-lead/log-status.sh "$SESSION_ID" "🔍 Exploring codebase..."
/home/openclaw/agents/dev-lead/log-status.sh "$SESSION_ID" "📝 Drafting plan..."
/home/openclaw/agents/dev-lead/log-status.sh "$SESSION_ID" "✅ Plan approved — starting CLI coding session"
/home/openclaw/agents/dev-lead/log-status.sh "$SESSION_ID" "🚀 Coding agent finished — running dev-harness"
```

#### `log-exec.sh` — Execution log (one row per action)
Posts `message_type="execution_log"`. Use during build/deploy/smoke phases.
Use these emoji prefixes — they control line colour in ExecutionLogCard:
- `🚀` — start of a phase (violet)
- `🔧` — running a command/action (blue)
- `📄` — file written or read (gray)
- `✅` — success (green)
- `❌` — failure (red)

```bash
/home/openclaw/agents/dev-lead/log-exec.sh "$SESSION_ID" "🚀 Starting build phase"
/home/openclaw/agents/dev-lead/log-exec.sh "$SESSION_ID" "🔧 docker build -t dev-session-app:latest ."
/home/openclaw/agents/dev-lead/log-exec.sh "$SESSION_ID" "✅ Build passed"
/home/openclaw/agents/dev-lead/log-exec.sh "$SESSION_ID" "🔧 docker service update --image dev-session-app:latest prod_dev-session-app"
/home/openclaw/agents/dev-lead/log-exec.sh "$SESSION_ID" "🔧 Smoke test → GET $SMOKE_URL"
/home/openclaw/agents/dev-lead/log-exec.sh "$SESSION_ID" "✅ Smoke test passed"
```

#### `read-and-log.sh` — File reading with console annotation
```bash
/home/openclaw/agents/dev-lead/read-and-log.sh "$SESSION_ID" dev-david src/components/MessageBubble.tsx
# → logs "📖 Reading src/components/MessageBubble.tsx..." to ConsolePanel
```

#### Activity Narration (REQUIRED)

Call `log-status.sh` at each step boundary in the AGENTS.md job loop:
```bash
log-status.sh "$SESSION_ID" "📚 Restoring session context from ops-db..."
log-status.sh "$SESSION_ID" "🔍 Exploring codebase..."
log-status.sh "$SESSION_ID" "📝 Drafting plan..."
log-status.sh "$SESSION_ID" "✅ Plan approved — starting CLI coding session"
log-status.sh "$SESSION_ID" "⚙️ Coding agent running..."
log-status.sh "$SESSION_ID" "🏗️ Running dev-harness..."
log-status.sh "$SESSION_ID" "✅ All checks passed — marking complete"
```

### Git operations — use container-mcp tools (preferred over docker exec)

```
container_mcp("git_status",   {"working_dir": "/home/david/<repo>"})
container_mcp("git_add",      {"working_dir": "/home/david/<repo>", "files": ["."]})
container_mcp("git_commit",   {"working_dir": "/home/david/<repo>", "message": "ZI-XXXXX: description"})
container_mcp("git_push",     {"working_dir": "/home/david/<repo>", "branch": "main"})
container_mcp("git_checkout", {"working_dir": "/home/david/<repo>", "branch": "feature/ZI-XXXXX-name", "create": true})
container_mcp("git_merge",    {"working_dir": "/home/david/<repo>", "branch": "feature/ZI-XXXXX-name"})
```

Do NOT use docker exec for git operations. container-mcp git tools are the only supported method.

### Completion Notification (REQUIRED)

```bash
openclaw slack send -c D0AHM734G1X "Dev-lead done: <one-line summary>. Session: https://dev-sessions.ash.zennya.app/sessions/<SESSION_ID>"
```

### After Completion — Documentation (REQUIRED)

1. Update WIP Confluence page: add "Completed" prefix to title, add summary.
2. Update Architecture page if stack/deployment changed.
3. Add Changelog entry.

```bash
mcporter call atlassian.confluence_update_page \
  --page_id "$WIP_PAGE_ID" \
  --title "Completed: $SESSION_ID - <task summary>" \
  --body "<p>Status: Completed</p><p>Summary: ...</p><p>Commits: ...</p>"
```

---

## Red Lines

### Safety

- The CLI coding session writes all code inside the container — avoid docker exec for file writes; use container-mcp git tools for commits
- **Never skip the approval_request step** — unless the task is explicitly classified as `trivial` (see Complexity Threshold section). When in doubt, use `low` and post the gate.
- Never post to Slack about jobs — only session UI
- Never mark a job done without a final checkpoint message
- When uncertain about scope, escalate to Ash

### ⛔ MANDATORY: Always work on a feature branch

**At the start of every session, before touching any code:**
1. `git checkout main && git pull origin main`
2. `git checkout -b feature/ZI-XXXXX-short-description`

Where `ZI-XXXXX` is the primary Jira ticket for this session. Required even for single-ticket sessions — ensures parallel sessions never conflict.

**Naming convention:** `feature/ZI-18743-approval-ux`, `feature/ZI-18742-activity-feed`, etc.

Never commit directly to `main`.

### ⛔ MANDATORY: Always merge to main before marking done

After all code changes are committed and tested:
1. `git checkout main`
2. `git merge <your-feature-branch> --no-ff`
3. `git push origin main`
4. Run deploy command
5. Smoke test
6. ONLY THEN mark the session complete in ops-db

Never mark a session done if your commits are only on a feature branch. Work is not shipped until it is on main and deployed.

### ⛔ MANDATORY: Verify git SHA in production repo before completion (ZI-18818)

Before posting ANY completion, checkpoint, or success message that references a commit:

1. `cd /home/openclaw/apps/<repo> && git pull && git log --oneline | head -5`
2. Confirm the merge commit SHA appears in the production repo's git log
3. If SHA is NOT found: **do not post completion**. Re-attempt merge/push or escalate to Ash with an explicit error message.
4. Only after SHA is confirmed in `/home/openclaw/apps/<repo>` may you post completion.

This prevents false success reports where dev-lead claims code landed but the commit does not exist in the production repo. The dev container workspace (`/home/david/<repo>`) and the production checkout (`/home/openclaw/apps/<repo>`) can diverge — always verify both.

### MANDATORY: Close Jira ticket to Done after shipping

After merging to main, deploy, and smoke test — ALWAYS transition the Jira issue to Done:

```python
import os, requests
from dotenv import load_dotenv
load_dotenv('/home/openclaw/agent-integrations/.env')
base = os.environ['JIRA_URL']
auth = (os.environ['JIRA_USERNAME'], os.environ['JIRA_API_TOKEN'])
key = '<JIRA_KEY>'  # e.g. ZI-18749

# Transition to Done (id=31)
r = requests.post(f'{base}/rest/api/2/issue/{key}/transitions',
    json={'transition': {'id': '31'}}, auth=auth)
assert r.status_code == 204, f"Transition failed: {r.status_code} {r.text}"
requests.post(f'{base}/rest/api/2/issue/{key}/comment',
    json={'body': f'Completed in session. Deployed to prod.'}, auth=auth)
print(f'{key} transitioned to Done')
```

Run this for EVERY Jira issue in the session. Never mark a session done with open Jira tickets.

### Complexity Threshold &amp; Auto-Approval (ZI-18730, ZI-18724, ZI-18757)

#### Complexity tiers

| Tier | Description | Approval gate? | Auto-approve after |
|------|-------------|----------------|--------------------|
| `trivial` | Single-file doc/comment edit, typo fix, config value tweak, README update | **No gate** — skip entirely | — |
| `low` | Config changes, minor UI copy, single env var, small docs page | Gate + countdown | **10 min** (600s) |
| `medium` | Single-component changes, small bug fixes, minor feature flags | Gate + countdown | **10 min** (600s) |
| `hard` | Multi-file changes, new features, schema migrations, API changes | Gate — **manual only** | Never |

> **Rule (ZI-18757):** Auto-approval timers must **never fire in under 10 minutes**. The minimum countdown for any auto-approving tier is 600 seconds. There is no "immediate" auto-approve.

> **Rule (ZI-18730):** Tasks classified as `trivial` skip the approval gate entirely. Do not post an `approval_request` for trivial tasks — proceed directly to coding.

> **Rule (ZI-18730 — single gate):** Post at most **ONE** `approval_request` per session. Do not create multiple approval waves for a single task. Only post a second gate if the user explicitly requests it, or if the task has truly independent deployment phases requiring separate gating (e.g., a schema migration approved independently from a code deploy).

#### How to classify

Before posting an approval request, reason through the task:
- Touches only `.md`, `.txt`, config values with no logic impact, or comment-only changes → `trivial`
- Touches 1 file with low risk, no schema/API changes → `low` or `medium`
- Touches multiple files, introduces new logic, changes APIs/schema → `hard`

When in doubt, escalate to the next tier up. Never downgrade to avoid the gate.

#### Metadata format

```python
metadata = json.dumps({
    'complexity': 'medium',   # trivial | low | medium | hard
    'question': 'Plan looks good?',
    'options': ['approve', 'reject']
})
```

For `low` and `medium`, the UI shows a 10-minute countdown before auto-approving.
For `hard`, the UI shows no countdown — David must explicitly approve.
