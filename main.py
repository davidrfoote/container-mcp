"""
container-mcp — execution runtime for dev containers.

Exposes tools for running processes inside dev containers:
code_task, run_tests, run_build, get_diff, get_repo_state,
get_model_status, probe_models, health.

Session lifecycle (bootstrap, approval, execution passes) is
handled by dev-mcp. Deployment is handled by deploy-orchestrator.
"""
from __future__ import annotations

import asyncio
import os

import uvicorn
from fastmcp import FastMCP

import config
from code_task import spawn_code_task
from model_registry import get_model_status, probe_models
from tools.git_ops import get_diff, get_repo_state

mcp = FastMCP("container-mcp")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _detect_and_run(working_dir: str, override_cmd: str | None, defaults: list[tuple[str, str]]) -> dict:
    # defaults is list of (indicator_file, command)
    # e.g. [("pytest.ini", "pytest"), ("package.json", "npm test"), ("Makefile", "make test")]
    cmd = override_cmd
    if not cmd:
        for indicator, default_cmd in defaults:
            if os.path.exists(os.path.join(working_dir, indicator)):
                cmd = default_cmd
                break
    if not cmd:
        return {"ok": False, "error": "could not detect test/build command, pass test_cmd explicitly"}
    proc = await asyncio.create_subprocess_shell(cmd, cwd=working_dir, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    stdout, stderr = await proc.communicate()
    return {"ok": proc.returncode == 0, "exit_code": proc.returncode, "output": (stdout + stderr).decode()}


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool()
async def code_task(
    instruction: str,
    working_dir: str,
    session_id: str | None = None,
    model: str | None = None,
    max_turns: int = 30,
    budget_usd: float = 5.0,
    timeout_seconds: int = 900,
    allowed_tools: list[str] | None = None,
    resume_claude_session_id: str | None = None,
    task_rules: str | None = None,
    effort: str | None = None,
) -> dict:
    """
    Spawn a coding task via Claude CLI inside a dev container. Returns immediately with
    {task_id, status: "spawned"} — progress streams to session_messages via session_id.
    Model accepts aliases: 'fast'/'haiku', 'balanced'/'sonnet', 'smart'/'opus'.
    Registry handles failover automatically.
    """
    if not config.CODE_TASK_ENABLED:
        return {"ok": False, "error": "CODE_TASK_ENABLED is false"}

    task_id = await spawn_code_task(
        instruction=instruction,
        working_dir=working_dir,
        session_id=session_id,
        model=model,
        max_turns=max_turns,
        budget_usd=budget_usd,
        timeout_seconds=timeout_seconds,
        allowed_tools=allowed_tools,
        resume_claude_session_id=resume_claude_session_id,
        task_rules=task_rules,
        effort=effort,
    )
    return {"task_id": task_id, "status": "spawned"}


@mcp.tool()
async def run_tests(working_dir: str, test_cmd: str | None = None) -> dict:
    """
    Detect and run the test suite in working_dir.
    Auto-detects pytest / npm test / make test from indicator files.
    Returns {ok, output, exit_code}.
    """
    return await _detect_and_run(working_dir, test_cmd, [
        ("pytest.ini", "pytest"),
        ("pyproject.toml", "pytest"),
        ("package.json", "npm test"),
        ("Makefile", "make test"),
    ])


@mcp.tool()
async def run_build(working_dir: str, build_cmd: str | None = None) -> dict:
    """
    Detect and run the build in working_dir.
    Auto-detects npm build / make / python build from indicator files.
    Returns {ok, output, exit_code}.
    """
    return await _detect_and_run(working_dir, build_cmd, [
        ("package.json", "npm run build"),
        ("Makefile", "make"),
        ("pyproject.toml", "python -m build"),
        ("setup.py", "python -m build"),
    ])


@mcp.tool()
async def get_diff(working_dir: str, diff_type: str = "working") -> dict:
    """Get git diff. diff_type: 'working' | 'staged' | 'head'."""
    diff = await get_diff(working_dir, diff_type)
    return {"ok": True, "diff": diff}


@mcp.tool()
async def get_repo_state(working_dir: str) -> dict:
    """Get branch, dirty status, staged files, and recent commits."""
    state = await get_repo_state(working_dir)
    return {"ok": True, **state}


@mcp.tool()
async def get_model_status() -> dict:
    """Returns health, availability, and config of all registered models."""
    return {"ok": True, "models": get_model_status()}


@mcp.tool()
async def probe_models() -> dict:
    """Actively probe all models for accessibility. Updates health state."""
    results = await probe_models()
    return {"ok": True, "probes": results}


@mcp.tool()
async def health() -> dict:
    """Health check."""
    return {"ok": True, "service": "container-mcp", "port": config.PORT}


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(mcp.get_app(), host="0.0.0.0", port=config.PORT)
