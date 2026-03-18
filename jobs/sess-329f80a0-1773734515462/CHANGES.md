# CHANGES — sess-329f80a0-1773734515462

## Files Modified

### `src/tools/deploy-project.ts`
- **Removed** (~225 lines): `callDeployAgent()`, `runInContainer()`, `runLocalCmd()`, `fetchUrl()`, `smokeTest()`, `detectAndRegisterProject()`, build phase, deploy phase, smoke test phase
- **Kept**: `withDeployClient()`, `lookupProject()`, `postSessionMessage()`, `DeployResult` interface
- **Added**: `buildDeployInstruction()` — constructs a structured deployment instruction for the CLI agent
- **Rewrote** `deployProject()`: looks up project for `working_dir`/`smoke_url` hints, falls back to `/home/david/{projectId}`, calls `spawnCodeTask()` with `maxTurns: 20`, `budgetUsd: 2.0`, `timeoutSeconds: 600`, `model: 'sonnet'`, returns immediately with `smoke_status: 'pending'`

### `src/mcp-server.ts`
- Updated `deploy_project` tool description to reflect CLI-agent-driven approach

## Key Decisions

- **No schema changes**: `lookupProject` now only selects `smoke_url` and `working_dir` — the other columns (`build_cmd`, `deploy_cmd`, `default_container`) are no longer needed by this layer
- **Fallback working dir**: If project has no DB row, falls back to `${AGENT_HOME_DIR}/{projectId}` (default `/home/david/{projectId}`) — consistent with old `detectAndRegisterProject` candidate list
- **PORT from env**: Deploy instruction uses `process.env.PORT ?? '9000'` for the checkpoint curl URL

## Deviations from impl-plan

None — implemented exactly as specified.

## Build

`npm run build` passed with zero errors.

## Commit

`feat(deploy_project): spawn code_task for CLI-driven deployment` — pushed to master.
