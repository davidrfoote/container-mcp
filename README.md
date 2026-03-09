# container-mcp

MCP server for dev container tool access. Provides AI coding agents with structured access to container build, test, diff, and git tools.

## Transport

- **Legacy SSE**: `GET /sse` + `POST /messages?sessionId=<id>` on port **9000**
- **Health**: `GET /health`

## Tools

| Tool | Description |
|------|-------------|
| `code_task` | Run a coding task via Claude or Cline agent inside the container |
| `get_task_log` | Retrieve buffered log lines for a running/completed task |
| `run_tests` | Execute test suite in a working directory |
| `run_build` | Execute build command in a working directory |
| `get_diff` | Get git diff (staged, working tree, or between refs) |
| `get_repo_state` | Get branch, dirty status, staged files, recent commits |

## Install

```bash
# In the host (openclaw), with GITHUB_TOKEN set:
bash install.sh dev-david
```

Or manually inside the container:

```bash
cd /home/david/container-mcp
npm install
npm run build
node dist/index.js
```

## MCP Config (Claude Desktop / OpenClaw)

```json
{
  "mcpServers": {
    "container": {
      "url": "http://localhost:9000/sse"
    }
  }
}
```

## code_task Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `instruction` | string | required | Task prompt |
| `working_dir` | string | required | CWD for agent |
| `driver` | `claude`\|`cline` | `claude` | Agent driver |
| `task_id` | string | auto UUID | Idempotency key |
| `max_turns` | number | 30 | Claude max turns |
| `budget_usd` | number | 5.0 | Claude budget cap |
| `timeout_seconds` | number | 900 | Process timeout |
| `task_rules` | string | — | Extra rules to append |
| `base_rules_path` | string | `/.rules/base.md` | Global rules file |
| `project_rules_path` | string | `/.rules/project.md` | Per-project rules |

## Logs

Server logs: `/home/david/container-mcp.log`
