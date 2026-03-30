# Task: Dev-Lead Endpoint Improvements

**Repo:** `container-mcp`  
**Scope:** Medium  
**Priority:** High — blocks all dev-lead execution

---

## Background

The dev-lead pipeline depends on three things that are currently broken or missing:

1. **`code_task` is feature-flagged off** — `CODE_TASK_ENABLED` env var is not set in the `devenv_dev-david` Swarm service, so the tool never appears to mcporter. Dev-lead has no way to run the Claude CLI coding agent.

2. **No "ask codebase" endpoint** — there is no way to ask a question about the code without triggering a full plan/approve/execute cycle. We need a lightweight read-only Q&A mode.

3. **No "ask project" endpoint** — there is no way to query the project's Jira backlog, Confluence docs, or roadmap without going through bootstrap. We need a direct project intelligence endpoint.

---

## Work Items

### 1. Enable `code_task` (trivial — env var)

Set `CODE_TASK_ENABLED=true` in the `devenv` Docker Compose/Swarm service config for `dev-david`.

**File to change:** `devenv/docker-compose.yml` (or equivalent stack file on the host)  
**Change:** Add `CODE_TASK_ENABLED=true` to the `dev-david` service environment.  
**Rebuild required:** No — service update only (`docker service update --env-add CODE_TASK_ENABLED=true devenv_dev-david`).

After this, mcporter will expose `code_task` and the full bootstrap → execute pipeline will work.

---

### 2. Add `ask_codebase` tool

A read-only Claude CLI pass that answers a free-form question about the codebase. No session, no approval, no plan. Just an answer.

**File:** `src/mcp-server.ts`

**Tool definition:**
```typescript
{
  name: "ask_codebase",
  description: "Ask a free-form question about a codebase. Runs a read-only Claude agent pass and returns the answer. No session or approval required.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "Short repo name (e.g. zennya-grails-server). Resolved to /home/david/<repo>" },
      question: { type: "string", description: "The question to answer about the codebase" },
      model: { type: "string", description: "Optional model override (default: haiku for speed)" },
    },
    required: ["repo", "question"],
  },
}
```

**Implementation:**
- Call `spawnCodeTask` with:
  - `instruction`: the question + instruction to answer concisely and return the answer as plain text
  - `workingDir`: `/home/david/<repo>`
  - `allowedTools`: `["Read", "Glob", "Grep", "Bash"]` (read-only, no web)
  - `maxTurns`: 10
  - `budgetUsd`: 0.50
  - `model`: `"haiku"` by default (fast + cheap for Q&A)
  - No `sessionId` — output goes to task log only
- Wait for completion (the current `spawnCodeTask` is fire-and-forget; add a Promise-based wrapper or use `get_task_log` polling)
- Return the final result text to the mcporter caller

**Note:** `spawnCodeTask` currently fires and forgets. To make `ask_codebase` synchronous, add a simple Promise wrapper that resolves on the `result` event from the Claude stream. See `code-task.ts` line ~60 where `parsed.type === "result"` is handled — resolve the promise there.

---

### 3. Add `ask_project` tool

Answers questions about a project's backlog, roadmap, Jira issues, and Confluence docs using cached context. No Claude CLI needed — just LLM over cached text.

**File:** `src/mcp-server.ts`

**Tool definition:**
```typescript
{
  name: "ask_project",
  description: "Ask a question about a project's backlog, roadmap, Jira issues, or Confluence documentation. Uses cached project context.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "Project ID from the projects table (e.g. zennya-grails-server)" },
      question: { type: "string", description: "The question to answer about the project" },
    },
    required: ["project_id", "question"],
  },
}
```

**Implementation:**
- Query `project_context_cache` for all cache keys matching `confluence:<id>` and `jira:<key>` for the given `project_id` (join via `projects` table for `confluence_root_id` and look up `jira_issue_keys` from recent sessions or a new `projects.jira_keys` column)
- Concatenate the cached summaries into a context string
- Call a lightweight LLM directly (use Anthropic SDK with `claude-haiku-4-5` or similar — NOT `spawnCodeTask`, no container CLI needed)
- Return the answer

**Alternative (simpler):** Use `chat_session` with the cached context injected as system prompt. This reuses existing infrastructure.

---

### 4. Update dev-lead SKILL.md

Once the above is built, update the dev-lead skill file at:
`/home/openclaw/apps/zennya-agent-config/openclaw/skills/global/dev-lead/SKILL.md`

- Replace references to `dev-harness run` with the direct `git_add` / `git_commit` / `git_push` tools (dev-harness may not exist on the current host path)
- Add documentation for `ask_codebase` and `ask_project` as available tools
- Clarify that `CODE_TASK_ENABLED=true` is now required

---

## Acceptance Criteria

- [ ] `mcporter list` shows `code_task` in `container-mcp-david` tool list
- [ ] `mcporter call container-mcp-david.ask_codebase repo="zennya-grails-server" question="What framework is this built on?"` returns a real answer
- [ ] `mcporter call container-mcp-david.ask_project project_id="zennya-grails-server" question="What are the current open Jira tickets?"` returns a real answer
- [ ] Dev-lead can run a full bootstrap → execute → commit cycle on a test repo
- [ ] Dev-lead SKILL.md updated to reflect the new tools

---

## Files to Change

| File | Change |
|------|--------|
| `devenv/docker-compose.yml` (host) | Add `CODE_TASK_ENABLED=true` env var to dev-david service |
| `container-mcp/src/mcp-server.ts` | Add `ask_codebase` and `ask_project` tool handlers |
| `container-mcp/src/code-task.ts` | Add Promise-based sync wrapper for `ask_codebase` |
| `zennya-agent-config/.../dev-lead/SKILL.md` | Update tool docs, remove dev-harness refs |

---

## Notes for Coding Agent

- Container-mcp source is at `/home/david/container-mcp/src/` inside `devenv_dev-david`
- Run `npm run build` after TypeScript changes, then restart the MCP process
- The MCP process is started via `/home/david/container-mcp/run-mcp.sh` or `start.sh`
- Test with: `curl -sf http://127.0.0.1:3201/health` (from host) to verify it's running
- The `spawnCodeTask` function in `code-task.ts` is the core primitive — reuse it

