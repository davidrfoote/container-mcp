# CHANGES — bootstrap_session: Replace spawnCodeTask with /hooks/agent

## Files Modified

- `src/bootstrap.ts` — Core change

## What Changed

### src/bootstrap.ts

**Removed:**
- Import of `spawnCodeTask` from `./code-task.js`
- The "Spawn BOOTSTRAP code task" try/catch block (lines 635-652) that forked a Claude CLI process directly

**Added:**
- Import of `buildSpawnMessage` from `./db.js` (alongside existing `withDbClient`)
- New async block that routes bootstrap through the OpenClaw gateway `/hooks/agent` endpoint:
  1. Reads `OPENCLAW_GATEWAY_URL` (default: `http://172.17.0.1:18789`) and `OPENCLAW_GATEWAY_TOKEN`
  2. Calls `buildSpawnMessage(sessionId, dbUrl, ashSessionKey)` to compose the dev-lead startup message
  3. POSTs to `${gatewayUrl}/hooks/agent` with `{ agentId: 'dev-lead', message, cwd: '/home/openclaw/agents/dev-lead' }`
  4. Extracts `childSessionKey` from response using nested-fallback pattern (mirrors create_session in mcp-server.ts)
  5. On success: `UPDATE sessions SET openclaw_session_key = $1, status = 'active'` (atomic)
  6. POSTs to `https://dev-sessions.ash.zennya.app/api/sessions/link` for A2A callback registration (non-fatal)
  7. On spawn failure: logs warning message to `session_messages` (same pattern as before)

**Not removed:** `buildBootstrapInstruction` function definition — kept as it may be referenced externally or in tests.

## Key Decisions

- Used `buildSpawnMessage` (not `buildBootstrapInstruction`) because the gateway routes to dev-lead, not Claude CLI directly. Dev-lead handles its own planning pass.
- Status set to `active` in the same UPDATE as `openclaw_session_key` for atomicity.
- The `/api/sessions/link` call is non-fatal — it's for traceability only.

## Notes

- `/home/openclaw/.openclaw/skills/dev-workflow/SKILL.md` was not accessible from this environment. The `sessions_spawn` reference update could not be applied. Manual update needed: replace instruction to call `sessions_spawn` with `agentId=dev-lead` → call `bootstrap_session` via mcporter (container-mcp MCP tool).
