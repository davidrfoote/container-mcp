"""
container-mcp v3 — execution runtime for dev containers.

Tools: code_task, run_tests, run_build, get_diff, get_repo_state,
get_model_status, probe_models, get_chain_status, get_task_log,
create_project, deploy_project, get_container_inventory, health,
and git operations.

Session lifecycle (bootstrap, approval, execution) is handled by dev-mcp.
Deployment orchestration is handled by deploy-orchestrator.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Any

import asyncpg
import uvicorn
from fastmcp import FastMCP

import config
from code_task import spawn_code_task, get_task_log as _get_task_log
from model_registry import (
    get_model_status as _get_model_status,
    get_chain_status as _get_chain_status,
    probe_models as _probe_models,
    init_registry,
)
from tools.git_ops import get_diff as _get_diff
from tools.git_ops import get_repo_state as _get_repo_state

mcp = FastMCP("container-mcp")

DEV_USER = os.getenv("DEV_USER", "david")


# ═══════════════════════════════════════════════════════════════════════════
# DB helpers
# ═══════════════════════════════════════════════════════════════════════════

async def _get_pool() -> asyncpg.Pool:
    if not hasattr(_get_pool, "_pool") or _get_pool._pool is None:
        _get_pool._pool = await asyncpg.create_pool(config.OPS_DB_URL, min_size=1, max_size=10)
    return _get_pool._pool

_get_pool._pool = None


async def _post_message(
    session_id: str, content: str,
    role: str = "dev_lead", message_type: str = "status_change",
    metadata: dict | None = None,
) -> dict:
    pool = await _get_pool()
    metadata_json = json.dumps(metadata) if metadata else None
    row = await pool.fetchrow(
        """INSERT INTO session_messages
               (message_id, session_id, role, content, message_type, metadata, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, now())
           RETURNING message_id, created_at""",
        session_id, role, content, message_type, metadata_json,
    )
    if row:
        notify_payload = json.dumps({
            "id": row["message_id"], "message_id": row["message_id"],
            "session_id": session_id, "role": role,
            "message_type": message_type, "content": content,
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        })
        safe_id = session_id.replace("-", "_")
        for channel in [f"session_messages_{safe_id}", "session_messages", f"session:{session_id}"]:
            try:
                await pool.execute("SELECT pg_notify($1, $2)", channel, notify_payload)
            except Exception:
                pass
    return {"ok": True, "message_id": row["message_id"] if row else None}


async def _run_git(repo: str, args: list[str], env: dict | None = None) -> dict:
    working_dir = f"/home/{DEV_USER}/{repo}"
    final_env = dict(os.environ)
    if env:
        final_env.update(env)
    proc = await asyncio.create_subprocess_exec(
        "git", *args, cwd=working_dir,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=final_env,
    )
    stdout, stderr = await proc.communicate()
    output = stdout.decode(errors="replace") + stderr.decode(errors="replace")
    return {"ok": proc.returncode == 0, "output": output.strip(), "exit_code": proc.returncode or 0}


async def _detect_and_run(working_dir: str, override_cmd: str | None, defaults: list[tuple[str, str]]) -> dict:
    cmd = override_cmd
    if not cmd:
        for indicator, default_cmd in defaults:
            if os.path.exists(os.path.join(working_dir, indicator)):
                cmd = default_cmd
                break
    if not cmd:
        return {"ok": False, "error": "could not detect command, pass explicitly"}
    proc = await asyncio.create_subprocess_shell(
        cmd, cwd=working_dir,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return {"ok": proc.returncode == 0, "exit_code": proc.returncode, "output": (stdout + stderr).decode()}


# ═══════════════════════════════════════════════════════════════════════════
# Coding tools
# ═══════════════════════════════════════════════════════════════════════════

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
    agents: str | None = None,
    allowed_dirs: list[str] | None = None,
    max_retries: int = 3,
) -> dict:
    """
    Spawn a coding task via Claude CLI with automatic model failover.
    Returns immediately with {task_id, status: "spawned"}.
    On rate_limit/quota/auth errors, automatically retries with next account in chain.
    Model accepts aliases: 'fast'/'haiku', 'balanced'/'sonnet', 'smart'/'opus', 'glm', 'minimax', etc.
    """
    if not config.CODE_TASK_ENABLED:
        return {"ok": False, "error": "CODE_TASK_ENABLED is false"}

    # Look up session's saved model if no explicit override
    resolved_model = model
    if not model and session_id:
        try:
            pool = await _get_pool()
            row = await pool.fetchrow("SELECT model FROM sessions WHERE session_id = $1", session_id)
            if row and row["model"]:
                resolved_model = row["model"]
        except Exception:
            pass

    task_id = await spawn_code_task(
        instruction=instruction,
        working_dir=working_dir,
        session_id=session_id,
        model=resolved_model,
        max_turns=max_turns,
        budget_usd=budget_usd,
        timeout_seconds=timeout_seconds,
        allowed_tools=allowed_tools,
        resume_claude_session_id=resume_claude_session_id,
        task_rules=task_rules,
        effort=effort,
        agents=agents,
        allowed_dirs=allowed_dirs,
        max_retries=max_retries,
    )
    return {"task_id": task_id, "status": "spawned", "model": resolved_model}


@mcp.tool()
async def run_tests(working_dir: str, test_cmd: str | None = None) -> dict:
    """Detect and run the test suite in working_dir."""
    return await _detect_and_run(working_dir, test_cmd, [
        ("pytest.ini", "pytest"), ("pyproject.toml", "pytest"),
        ("package.json", "npm test"), ("Makefile", "make test"),
    ])


@mcp.tool()
async def run_build(working_dir: str, build_cmd: str | None = None) -> dict:
    """Detect and run the build in working_dir."""
    return await _detect_and_run(working_dir, build_cmd, [
        ("package.json", "npm run build"), ("Makefile", "make"),
        ("pyproject.toml", "python -m build"), ("setup.py", "python -m build"),
    ])


@mcp.tool()
async def get_task_log(task_id: str) -> dict:
    """Return all captured log lines for a task."""
    lines = _get_task_log(task_id)
    return {"ok": True, "task_id": task_id, "lines": lines[-200:], "total": len(lines)}


# ═══════════════════════════════════════════════════════════════════════════
# Model tools
# ═══════════════════════════════════════════════════════════════════════════

@mcp.tool()
async def get_model_status() -> dict:
    """Returns health, availability, and budget of all registered model accounts."""
    return {"ok": True, "accounts": _get_model_status(), "chains": _get_chain_status()}


@mcp.tool()
async def probe_models() -> dict:
    """Actively probe all model accounts for reachability."""
    results = await _probe_models()
    return {"ok": True, "probes": results}


@mcp.tool()
async def get_chain_status() -> dict:
    """Return chain definitions with slot availability."""
    return {"ok": True, "chains": _get_chain_status()}


# ═══════════════════════════════════════════════════════════════════════════
# Diff / repo state
# ═══════════════════════════════════════════════════════════════════════════

@mcp.tool()
async def get_diff(working_dir: str, diff_type: str = "working") -> dict:
    """Get git diff. diff_type: 'working' | 'staged' | 'head'."""
    diff = await _get_diff(working_dir, diff_type)
    return {"ok": True, "diff": diff}


@mcp.tool()
async def get_repo_state(working_dir: str) -> dict:
    """Get branch, dirty status, staged files, and recent commits."""
    state = await _get_repo_state(working_dir)
    return {"ok": True, **state}


# ═══════════════════════════════════════════════════════════════════════════
# Git tools
# ═══════════════════════════════════════════════════════════════════════════

_GIT_AUTHOR_ENV = {
    "GIT_AUTHOR_NAME": "Dev-Lead Agent",
    "GIT_AUTHOR_EMAIL": "dev-lead@zennya.app",
    "GIT_COMMITTER_NAME": "Dev-Lead Agent",
    "GIT_COMMITTER_EMAIL": "dev-lead@zennya.app",
}


@mcp.tool()
async def git_status(repo: str) -> dict:
    """Get git status for a repo."""
    working_dir = f"/home/{DEV_USER}/{repo}"
    state = await _get_repo_state(working_dir)
    return {"ok": True, **state}


@mcp.tool()
async def git_checkout(repo: str, branch: str, create: bool = False) -> dict:
    args = ["checkout", "-b", branch] if create else ["checkout", branch]
    return await _run_git(repo, args)


@mcp.tool()
async def git_add(repo: str, files: list[str]) -> dict:
    return await _run_git(repo, ["add", *files])


@mcp.tool()
async def git_commit(repo: str, message: str) -> dict:
    return await _run_git(repo, ["commit", "-m", message], env=_GIT_AUTHOR_ENV)


@mcp.tool()
async def git_push(repo: str, branch: str | None = None, force: bool = False) -> dict:
    args = ["push"]
    if force:
        args.append("--force")
    args.append("origin")
    if branch:
        args.append(branch)
    return await _run_git(repo, args)


@mcp.tool()
async def git_merge(repo: str, branch: str, no_ff: bool = True) -> dict:
    args = ["merge"]
    if no_ff:
        args.append("--no-ff")
    args.append(branch)
    return await _run_git(repo, args)


@mcp.tool()
async def git_pull(repo: str) -> dict:
    return await _run_git(repo, ["pull", "--rebase", "origin"])


@mcp.tool()
async def create_git_worktree(repo: str, base_branch: str = "main", worktree_id: str | None = None) -> dict:
    import time as _time
    import random
    wid = worktree_id or f"wt-{int(_time.time())}-{random.randint(1000, 9999)}"
    worktree_path = f"/tmp/{repo}-{wid}"
    branch_name = f"worktree/{wid}"
    repo_dir = f"/home/{DEV_USER}/{repo}"

    await _run_git(repo, ["fetch", "origin", base_branch])
    proc = await asyncio.create_subprocess_exec(
        "git", "worktree", "add", "-b", branch_name, worktree_path, f"origin/{base_branch}",
        cwd=repo_dir, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    output = stdout.decode(errors="replace") + stderr.decode(errors="replace")
    if proc.returncode != 0:
        return {"ok": False, "output": output.strip(), "exit_code": proc.returncode}
    return {
        "ok": True, "worktree_path": worktree_path,
        "branch": branch_name, "base_branch": base_branch,
        "repo_dir": repo_dir, "output": output.strip(),
    }


@mcp.tool()
async def delete_git_worktree(worktree_path: str, delete_branch: bool = False) -> dict:
    worktree_branch = None
    if delete_branch:
        proc = await asyncio.create_subprocess_exec(
            "git", "rev-parse", "--abbrev-ref", "HEAD",
            cwd=worktree_path, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0:
            worktree_branch = stdout.decode().strip()

    proc = await asyncio.create_subprocess_exec(
        "git", "worktree", "list", "--porcelain",
        cwd=worktree_path, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    main_repo_dir = None
    if proc.returncode == 0:
        for line in stdout.decode().splitlines():
            if line.startswith("worktree "):
                main_repo_dir = line[9:]
                break

    remove_cwd = main_repo_dir or worktree_path
    proc = await asyncio.create_subprocess_exec(
        "git", "worktree", "remove", worktree_path, "--force",
        cwd=remove_cwd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    output = stdout.decode(errors="replace") + stderr.decode(errors="replace")

    branch_deleted = False
    if delete_branch and worktree_branch and main_repo_dir and proc.returncode == 0:
        proc2 = await asyncio.create_subprocess_exec(
            "git", "branch", "-D", worktree_branch,
            cwd=main_repo_dir, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await proc2.communicate()
        branch_deleted = proc2.returncode == 0

    return {"ok": proc.returncode == 0, "output": output.strip(), "branch_deleted": branch_deleted}


@mcp.tool()
async def list_git_worktrees(repo: str) -> dict:
    repo_dir = f"/home/{DEV_USER}/{repo}"
    proc = await asyncio.create_subprocess_exec(
        "git", "worktree", "list", "--porcelain",
        cwd=repo_dir, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        return {"ok": False, "output": (stdout + stderr).decode(errors="replace").strip()}

    worktrees = []
    current: dict = {}
    for line in stdout.decode(errors="replace").splitlines():
        if line.startswith("worktree "):
            if current.get("path"):
                worktrees.append(current)
            current = {"path": line[9:]}
        elif line.startswith("HEAD "):
            current["head"] = line[5:]
        elif line.startswith("branch "):
            current["branch"] = line[7:]
        elif line == "bare":
            current["bare"] = True
        elif line == "detached":
            current["detached"] = True
    if current.get("path"):
        worktrees.append(current)
    return {"ok": True, "worktrees": worktrees}


# ═══════════════════════════════════════════════════════════════════════════
# Session / DB tools
# ═══════════════════════════════════════════════════════════════════════════

@mcp.tool()
async def post_message(
    session_id: str, content: str,
    role: str = "dev_lead", message_type: str = "status_change",
    metadata: dict | None = None,
) -> dict:
    """Post a message to a session feed."""
    result = await _post_message(session_id, content, role, message_type, metadata)
    if session_id:
        try:
            pool = await _get_pool()
            if message_type == "approval_request":
                await pool.execute(
                    "UPDATE sessions SET status = 'awaiting_approval', updated_at = now() WHERE session_id = $1 AND status != 'awaiting_approval'",
                    session_id,
                )
            elif message_type == "checkpoint" and role == "coding_agent":
                await pool.execute(
                    "UPDATE sessions SET status = 'active', updated_at = now() WHERE session_id = $1 AND status = 'executing'",
                    session_id,
                )
        except Exception:
            pass
    return result


@mcp.tool()
async def listen_for_approval(session_id: str, timeout_seconds: int = 1800) -> dict:
    """Wait on Postgres LISTEN/NOTIFY for an approval_response."""
    pool = await _get_pool()
    conn = await pool.acquire()
    try:
        channel = f"session:{session_id}"
        quoted = f'"{channel}"'
        await conn.execute(f"LISTEN {quoted}")

        got_it = False

        def _on_notify(n: asyncpg.notifications.Notification) -> None:
            nonlocal got_it
            if n.channel == channel:
                got_it = True

        conn.add_Listener(_on_notify)
        try:
            if not got_it:
                await asyncio.wait_for(
                    asyncio.get_event_loop().create_future(),
                    timeout=timeout_seconds,
                )
        except asyncio.TimeoutError:
            pass
        finally:
            conn.remove_Listener(_on_notify)

        if not got_it:
            row = await conn.fetchrow(
                """SELECT content FROM session_messages
                   WHERE session_id = $1 AND message_type = 'approval_response' AND role != 'dev_lead'
                   ORDER BY created_at DESC LIMIT 1""",
                session_id,
            )
            if row:
                return {"approved": True, "content": row["content"]}
            return {"approved": False, "timed_out": True}

        row = await conn.fetchrow(
            """SELECT content FROM session_messages
               WHERE session_id = $1 AND message_type = 'approval_response' AND role != 'dev_lead'
               ORDER BY created_at DESC LIMIT 1""",
            session_id,
        )
        if row:
            return {"approved": True, "content": row["content"]}
        return {"approved": False}
    finally:
        await conn.execute(f"UNLISTEN {quoted}")
        await pool.release(conn)


@mcp.tool()
async def transition_session(session_id: str, to_status: str) -> dict:
    """Transition a session's status."""
    pool = await _get_pool()
    valid = {"pending", "active", "executing", "awaiting_approval", "planning", "paused", "completed", "failed"}
    if to_status not in valid:
        return {"ok": False, "error": f"Invalid status: {to_status}. Valid: {', '.join(sorted(valid))}"}
    result = await pool.execute(
        "UPDATE sessions SET status = $1, updated_at = now() WHERE session_id = $2",
        to_status, session_id,
    )
    if result == "UPDATE 0":
        return {"ok": False, "error": f"Session not found: {session_id}"}
    return {"ok": True, "session_id": session_id, "status": to_status}


@mcp.tool()
async def get_session_provenance(session_id: str) -> dict:
    """Get full provenance and timeline for a session."""
    pool = await _get_pool()
    session = await pool.fetchrow(
        """SELECT session_id, project_id, status, branch, worktree_path,
                  jira_issue_keys, model, num_turns, cost_usd, created_at
           FROM sessions WHERE session_id = $1""",
        session_id,
    )
    if not session:
        return {"ok": False, "error": f"Session not found: {session_id}"}

    messages = await pool.fetch(
        """SELECT message_type, role, created_at, content
           FROM session_messages WHERE session_id = $1
           ORDER BY created_at ASC LIMIT 100""",
        session_id,
    )
    timeline = [
        {
            "message_type": m["message_type"], "role": m["role"],
            "created_at": m["created_at"].isoformat() if m["created_at"] else None,
            "content_preview": (m["content"] or "")[:200],
        }
        for m in messages
    ]
    return {
        "ok": True,
        "session_id": session["session_id"],
        "project_id": session["project_id"],
        "status": session["status"],
        "branch": session["branch"],
        "worktree_path": session["worktree_path"],
        "model": session["model"],
        "cost_usd": float(session["cost_usd"]) if session["cost_usd"] else None,
        "timeline": timeline,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Project tools (ported from TS)
# ═══════════════════════════════════════════════════════════════════════════

@mcp.tool()
async def create_project(
    project_id: str,
    display_name: str | None = None,
    description: str | None = None,
    working_dir: str | None = None,
    default_container: str | None = None,
    build_cmd: str | None = None,
    smoke_url: str | None = None,
    jira_issue_keys: list[str] | None = None,
    confluence_root_id: str | None = None,
) -> dict:
    """Create or update a project in ops-db. Auto-detects working_dir and build_cmd if not provided."""
    pool = await _get_pool()

    # Auto-detect working_dir
    if not working_dir:
        for candidate in [f"/home/{DEV_USER}/{project_id}", f"/home/openclaw/apps/{project_id}", f"/opt/{project_id}"]:
            if os.path.exists(candidate):
                working_dir = candidate
                break

    # Auto-detect build_cmd
    if working_dir and not build_cmd:
        wd = Path(working_dir)
        if (wd / "swarm.yml").exists() or (wd / "Dockerfile").exists():
            build_cmd = f"cd {working_dir} && docker build -t {project_id}:latest ."
        elif (wd / "package.json").exists():
            build_cmd = f"cd {working_dir} && npm install && npm run build"
        elif (wd / "requirements.txt").exists():
            build_cmd = f"cd {working_dir} && pip install -r requirements.txt -q"
        elif (wd / "pyproject.toml").exists():
            build_cmd = f"cd {working_dir} && pip install . -q"

    try:
        jira_arr = jira_issue_keys if jira_issue_keys else None

        await pool.execute(
            """INSERT INTO projects
                   (project_id, display_name, description, working_dir, default_container,
                    build_cmd, smoke_url, jira_issue_keys, confluence_root_id, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, now(), now())
               ON CONFLICT (project_id) DO UPDATE SET
                 display_name = COALESCE(EXCLUDED.display_name, projects.display_name),
                 description = COALESCE(EXCLUDED.description, projects.description),
                 working_dir = COALESCE(EXCLUDED.working_dir, projects.working_dir),
                 default_container = COALESCE(EXCLUDED.default_container, projects.default_container),
                 build_cmd = COALESCE(EXCLUDED.build_cmd, projects.build_cmd),
                 smoke_url = COALESCE(EXCLUDED.smoke_url, projects.smoke_url),
                 jira_issue_keys = COALESCE(EXCLUDED.jira_issue_keys, projects.jira_issue_keys),
                 confluence_root_id = COALESCE(EXCLUDED.confluence_root_id, projects.confluence_root_id),
                 updated_at = now()""",
            project_id, display_name, description, working_dir,
            default_container, build_cmd, smoke_url,
            jira_arr, confluence_root_id,
        )

        row = await pool.fetchrow(
            """SELECT project_id, display_name, description, working_dir, default_container,
                      build_cmd, smoke_url, jira_issue_keys, confluence_root_id, created_at, updated_at
               FROM projects WHERE project_id = $1""",
            project_id,
        )
        return {"ok": True, "project": dict(row) if row else None}

    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def deploy_project(project_id: str, session_id: str | None = None) -> dict:
    """Spawn a CLI agent to build, deploy, and smoke-test a project."""
    pool = await _get_pool()

    # Look up project
    row = await pool.fetchrow(
        "SELECT smoke_url, working_dir FROM projects WHERE project_id = $1",
        project_id,
    )
    working_dir = (row["working_dir"] if row else None) or f"/home/{DEV_USER}/{project_id}"
    smoke_url = row["smoke_url"] if row else None

    if session_id:
        await _post_message(session_id, f"🚀 Spawning CLI deploy agent for '{project_id}'...", "dev_lead", "console")

    # Build deploy instruction
    smoke_step = (
        f"5. **Smoke test**: GET {smoke_url} — retry up to 12 times with 5s delay."
        if smoke_url else "5. **Smoke test**: No smoke_url configured — skip."
    )
    port = os.getenv("PORT", "9000")
    checkpoint = (
        f"curl -s -X POST http://localhost:{port}/session/{session_id}/message "
        f"-H 'Content-Type: application/json' "
        f"-d '{{\"content\": \"deploy_project({project_id}) complete — <summarize result>\", \"message_type\": \"checkpoint\"}}'"
        if session_id else ""
    )

    instruction = f"""# Deploy project: {project_id}
Working directory: {working_dir}

## Steps
1. **Inspect topology**: Read swarm.yml, docker-compose.yml, Dockerfile, deploy.sh, Makefile, or package.json to determine build/deploy commands.
2. **Build**: Run the build command. Fix errors before proceeding.
3. **Deploy**: Run deploy command. Confirm service is running.
4. **Verify**: Check process/container status.
{smoke_step}
{"6. **Report**: Post checkpoint: " + checkpoint if checkpoint else ""}"""

    task_id = await spawn_code_task(
        instruction=instruction,
        working_dir=working_dir,
        session_id=session_id,
        max_turns=20,
        budget_usd=2.0,
        timeout_seconds=600,
        model="sonnet",
    )
    return {
        "ok": True,
        "task_id": task_id,
        "project_id": project_id,
        "smoke_status": "pending",
    }


@mcp.tool()
async def get_container_inventory() -> dict:
    """Get full inventory: tool registry, active sessions, worktrees, DB health."""
    pool = await _get_pool()
    db_health = "ok"

    try:
        await pool.execute("SELECT 1")
    except Exception:
        db_health = "error"

    # Active sessions
    active_sessions = []
    try:
        rows = await pool.fetch(
            """SELECT session_id, project_id, status, active_task_id, branch
               FROM sessions WHERE active_task_id IS NOT NULL
               ORDER BY updated_at DESC LIMIT 20"""
        )
        active_sessions = [dict(r) for r in rows]
    except Exception:
        pass

    # Worktrees
    worktrees = []
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "worktree", "list", "--porcelain",
            cwd=f"/home/{DEV_USER}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0:
            current: dict = {}
            for line in stdout.decode().splitlines():
                if line.startswith("worktree "):
                    if current.get("path"):
                        worktrees.append(current)
                    current = {"path": line[9:]}
                elif line.startswith("branch "):
                    current["branch"] = line[7:]
            if current.get("path"):
                worktrees.append(current)
    except Exception:
        pass

    # Tool registry
    tool_names = [
        "code_task", "get_task_log", "run_tests", "run_build",
        "git_status", "git_checkout", "git_add", "git_commit", "git_push",
        "git_merge", "git_pull", "create_git_worktree", "delete_git_worktree",
        "list_git_worktrees", "get_diff", "get_repo_state",
        "chat_session", "listen_for_approval", "post_message",
        "create_project", "deploy_project",
        "run_bootstrap_planning",  # reserved — calls dev-mcp
        "transition_session", "get_session_provenance", "get_container_inventory",
        "get_model_status", "probe_models", "get_chain_status",
    ]

    return {
        "ok": True,
        "version": "3.0.0-py",
        "db_health": db_health,
        "tools": tool_names,
        "active_sessions": active_sessions,
        "worktrees": worktrees,
        "dev_user": DEV_USER,
        "claude_bin": shutil.which("claude") or "not found",
    }


@mcp.tool()
async def chat_session(
    message: str,
    session_id: str | None = None,
    claude_session_id: str | None = None,
    working_dir: str | None = None,
    model: str | None = None,
) -> dict:
    """Run a direct interactive chat via Claude CLI. Streams output to session_messages."""
    if not working_dir:
        working_dir = f"/home/{DEV_USER}/dev-session-app"

    from model_registry import resolve_model
    resolved = resolve_model(model)

    args = [
        shutil.which("claude") or "claude",
        "-p", message,
        "--output-format", "stream-json",
        "--verbose",
        "--model", resolved.model,
    ]
    if claude_session_id:
        args.extend(["--resume", claude_session_id])

    child_env = dict(os.environ)
    for key, val in resolved.env_overrides.items():
        if val is None:
            child_env.pop(key, None)
        else:
            child_env[key] = val

    proc = await asyncio.create_subprocess_exec(
        *args, cwd=working_dir, env=child_env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )

    full_text = ""
    result_session_id = None

    try:
        async with asyncio.timeout(600):
            async for raw_line in proc.stdout:
                line = raw_line.decode(errors="replace").strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                    if ev.get("type") == "assistant":
                        for block in ev.get("message", {}).get("content", []):
                            if block.get("type") == "text" and block.get("text", "").strip():
                                text = block["text"].strip()
                                full_text += text + "\n"
                                if session_id:
                                    await _post_message(session_id, text, "coding_agent", "execution_log")
                    elif ev.get("type") == "result":
                        result_session_id = ev.get("session_id")
                except json.JSONDecodeError:
                    pass
    except TimeoutError:
        proc.kill()

    await proc.wait()

    if session_id and full_text.strip():
        await _post_message(session_id, full_text.strip(), "coding_agent", "chat")

    if result_session_id and session_id:
        try:
            pool = await _get_pool()
            await pool.execute(
                "UPDATE sessions SET claude_session_id = $1, updated_at = now() WHERE session_id = $2",
                result_session_id, session_id,
            )
        except Exception:
            pass

    return {"claude_session_id": result_session_id, "response": full_text.strip()}


# ═══════════════════════════════════════════════════════════════════════════
# Health
# ═══════════════════════════════════════════════════════════════════════════

@mcp.tool()
async def health() -> dict:
    """Health check."""
    return {
        "ok": True,
        "service": "container-mcp",
        "version": "3.0.0-py",
        "port": config.PORT,
        "dev_user": DEV_USER,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Entrypoint
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    init_registry()
    uvicorn.run(mcp.http_app(transport="sse"), host="0.0.0.0", port=config.PORT)
