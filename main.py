"""
container-mcp — Python rewrite.

FastMCP server exposing all agent tools:
  code_task, bootstrap_session, model status/probe,
  git ops, build/test runners, deploy trigger, health check.
"""
from __future__ import annotations

import asyncio
from typing import Any

import uvicorn
from fastmcp import FastMCP

import config
from bootstrap import bootstrap_session
from code_task import spawn_code_task
from listen_chain import start_listen_chain
from model_registry import get_model_status, probe_models
from tools.deploy import deploy_project
from tools.git_ops import get_diff, get_repo_state

mcp = FastMCP("container-mcp")


# ---------------------------------------------------------------------------
# Code task
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
    Run a coding task via Claude CLI. Returns task_id immediately (non-blocking).
    Progress streams to dev-session-app via session_id.
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
    return {"ok": True, "task_id": task_id}


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

@mcp.tool()
async def bootstrap_session_tool(
    session_id: str,
    repo: str,
    task_description: str,
    user_id: str | None = None,
    model: str | None = None,
) -> dict:
    """
    Initialize a dev session with a BOOTSTRAP planning pass.
    Claude reads the codebase (read-only) and produces an implementation plan.
    Call start_listen_chain_tool afterward to wait for approval and run execution.
    """
    result = await bootstrap_session(
        session_id=session_id,
        repo=repo,
        task_description=task_description,
        user_id=user_id,
    )
    return {"ok": True, **result}


@mcp.tool()
async def start_listen_chain_tool(
    session_id: str,
    claude_session_id: str,
    working_dir: str,
    model: str | None = None,
) -> dict:
    """
    Start polling for approval on a bootstrapped session.
    When the user approves, spawns the EXECUTION pass resuming the Claude session.
    Fires and forgets into background asyncio task.
    """
    asyncio.create_task(
        start_listen_chain(
            session_id=session_id,
            claude_session_id=claude_session_id,
            working_dir=working_dir,
            model=model,
        )
    )
    return {"ok": True, "session_id": session_id, "listening": True}


# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------

@mcp.tool()
async def get_model_status_tool() -> dict:
    """Returns health, availability, and config of all registered models."""
    return {"ok": True, "models": get_model_status()}


@mcp.tool()
async def probe_models_tool() -> dict:
    """Actively probe all models for accessibility. Updates health state."""
    results = await probe_models()
    return {"ok": True, "probes": results}


# ---------------------------------------------------------------------------
# Build and test
# ---------------------------------------------------------------------------

async def _run_cmd(cmd: str, cwd: str, timeout: int = 300) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_shell(
        cmd,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(timeout):
            stdout, stderr = await proc.communicate()
    except TimeoutError:
        proc.kill()
        return {"ok": False, "error": f"timed out after {timeout}s", "returncode": -1}

    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stdout": stdout.decode(errors="replace")[:4000],
        "stderr": stderr.decode(errors="replace")[:2000],
    }


@mcp.tool()
async def run_tests(working_dir: str, test_cmd: str | None = None) -> dict:
    """Run test suite in working_dir. Auto-detects pytest / npm test if test_cmd omitted."""
    import os
    if test_cmd is None:
        if os.path.exists(os.path.join(working_dir, "pytest.ini")) or \
                os.path.exists(os.path.join(working_dir, "pyproject.toml")):
            test_cmd = "pytest"
        elif os.path.exists(os.path.join(working_dir, "package.json")):
            test_cmd = "npm test"
        else:
            test_cmd = "pytest"
    return await _run_cmd(test_cmd, working_dir)


@mcp.tool()
async def run_build(working_dir: str, build_cmd: str | None = None) -> dict:
    """Run build command in working_dir. Auto-detects npm/make/python if build_cmd omitted."""
    import os
    if build_cmd is None:
        if os.path.exists(os.path.join(working_dir, "package.json")):
            build_cmd = "npm run build"
        elif os.path.exists(os.path.join(working_dir, "Makefile")):
            build_cmd = "make"
        else:
            build_cmd = "python -m build"
    return await _run_cmd(build_cmd, working_dir)


# ---------------------------------------------------------------------------
# Git ops
# ---------------------------------------------------------------------------

@mcp.tool()
async def get_diff_tool(working_dir: str, diff_type: str = "working") -> dict:
    """Get git diff. diff_type: 'working' | 'staged' | 'head'."""
    diff = await get_diff(working_dir, diff_type)
    return {"ok": True, "diff": diff}


@mcp.tool()
async def get_repo_state_tool(working_dir: str) -> dict:
    """Get branch, dirty status, staged files, recent commits."""
    state = await get_repo_state(working_dir)
    return {"ok": True, **state}


# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

@mcp.tool()
async def deploy_project_tool(
    project_id: str,
    branch: str = "main",
    session_id: str | None = None,
) -> dict:
    """Deploy a project via deploy-orchestrator."""
    return await deploy_project(project_id, branch, session_id)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@mcp.tool()
async def health() -> dict:
    """Health check — returns server version and config summary."""
    return {
        "ok": True,
        "server": "container-mcp",
        "language": "python",
        "port": config.PORT,
        "code_task_enabled": config.CODE_TASK_ENABLED,
        "default_model": config.DEFAULT_MODEL,
        "deploy_orchestrator_url": config.DEPLOY_ORCHESTRATOR_URL,
    }


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(mcp.get_app(), host="0.0.0.0", port=config.PORT)
