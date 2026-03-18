# CHANGES — sess-b9e6f570-1773855908306

## Files Modified / Created

### `src/closeout.ts` (NEW)
Direct close-out module — no external agent dependency.
- `fetchCloseoutInfo()`: queries sessions + projects for branch, project_id, jira_issue_keys, title, github_repo
- `createPullRequest()`: GitHub REST API POST /repos/{owner}/{repo}/pulls — handles "already exists" gracefully
- `mergeSquash()`: GitHub REST API PUT /repos/{owner}/{repo}/pulls/{number}/merge with merge_method squash — non-fatal on failure
- `runCloseout()`: orchestrates all steps; uses GITHUB_TOKEN, GITHUB_REPO_OWNER (default davidrfoote), GITHUB_BASE_BRANCH (default main); always marks pending_review even if PR creation fails
- `markPendingReview()`: UPDATE sessions SET status = 'pending_review'

### `src/listen-chain.ts` (MODIFIED)
- Added import: runCloseout from ./closeout.js
- Added runBackfillCloseout(dbUrl) function (Backfill 3): finds active non-interactive sessions with a coding_agent checkpoint and runs close-out for each
- Replaced checkpoint handler: removed gateway sessions_spawn call, now calls runCloseout() directly
- Added void runBackfillCloseout(dbUrl) call at startup alongside existing backfills

### `src/db.ts` (MODIFIED)
- Added migration to ensureMigrations(): ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo TEXT
- Allows per-project GitHub repo override. NULL triggers fallback to GITHUB_REPO_OWNER/project_id.

## Key Decisions

1. Direct implementation over gateway delegation — previous approach had no backfill, no guaranteed execution
2. Non-fatal PR creation — if branch has no diff, close-out still marks pending_review
3. Non-fatal auto-merge — merge failures leave PR open for manual review, close-out still completes
4. Backfill 3 safety net — same pattern as Backfill 2, runs once per reconnect
5. github_repo column — per-project override in projects table, falls back to env + project_id

## Build
npm run build passed with zero TypeScript errors.

## Commit
feat: direct close-out in listen-chain (PR creation + auto-merge + pending_review)
Branch: ash/task-fix-the-close-out-automation-i — already pushed to origin.
