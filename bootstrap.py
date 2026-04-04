"""
Session bootstrapping — creates/updates the session record and spawns
a read-only BOOTSTRAP planning pass via Claude CLI.
"""
from __future__ import annotations

from datetime import datetime, timezone

from db import get_session, update_session
from code_task import spawn_code_task
from feed import post_json_to_feed


_BOOTSTRAP_ALLOWED_TOOLS = [
    "Glob",
    "Grep",
    "Read",
    "Bash",
    "WebFetch",
    "WebSearch",
]


def _build_bootstrap_instruction(task: str, repo: str, session_id: str) -> str:
    return f"""You are in BOOTSTRAP mode for session {session_id}.

TASK: {task}

Your job is to:
1. Read and understand the codebase in {repo}
2. Form a clear implementation plan
3. Post an approval_request with your plan

Rules:
- READ ONLY. Do not write, edit, or delete any files.
- Do not make any git commits.
- End by calling the approval_request tool with your complete plan.

Repo: {repo}
"""


async def bootstrap_session(
    session_id: str,
    repo: str,
    task_description: str,
    user_id: str | None = None,
) -> dict:
    """
    Initialize a dev session:
    1. Create/update session record in DB
    2. Build the BOOTSTRAP instruction
    3. Spawn BOOTSTRAP pass (planning only, no writes)
    4. Return session info dict

    The DB row must already exist (created by the caller or dev-session-app).
    We update status -> active and record bootstrap metadata.
    """
    now = datetime.now(timezone.utc)

    # Upsert session fields we own
    await update_session(
        session_id,
        status="active",
        repo=repo,
        task_description=task_description,
        updated_at=now,
        **({"user_id": user_id} if user_id else {}),
    )

    instruction = _build_bootstrap_instruction(
        task=task_description,
        repo=repo,
        session_id=session_id,
    )

    await post_json_to_feed(session_id, {
        "kind": "bootstrap_start",
        "session_id": session_id,
        "repo": repo,
        "task": task_description,
    })

    task_id = await spawn_code_task(
        instruction=instruction,
        working_dir=repo,
        session_id=session_id,
        allowed_tools=_BOOTSTRAP_ALLOWED_TOOLS,
        max_turns=20,
        budget_usd=1.0,
        timeout_seconds=300,
    )

    return {
        "session_id": session_id,
        "task_id": task_id,
        "repo": repo,
        "status": "active",
        "phase": "bootstrap",
    }
