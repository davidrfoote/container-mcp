"""
Listen chain — polls ops-db for an approval_response on a session,
then either spawns an EXECUTION pass or marks the session failed.

Runs as a background asyncio task started by bootstrap_session callers.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from db import get_pool, update_session
from code_task import spawn_code_task
from feed import post_json_to_feed

_POLL_INTERVAL = 5       # seconds between DB polls
_TIMEOUT_SECONDS = 1800  # 30 minutes


async def _wait_for_approval(
    session_id: str,
    after: datetime,
) -> dict | None:
    """
    Poll session_messages for an approval_response row created after `after`.
    Returns the row dict on approval, None on timeout.
    """
    pool = await get_pool()
    deadline = asyncio.get_event_loop().time() + _TIMEOUT_SECONDS

    while asyncio.get_event_loop().time() < deadline:
        row = await pool.fetchrow(
            """
            SELECT * FROM session_messages
            WHERE session_id = $1
              AND message_type = 'approval_response'
              AND created_at > $2
            ORDER BY created_at ASC
            LIMIT 1
            """,
            session_id,
            after,
        )
        if row is not None:
            return dict(row)
        await asyncio.sleep(_POLL_INTERVAL)

    return None


async def start_listen_chain(
    session_id: str,
    claude_session_id: str,
    working_dir: str,
    model: str | None = None,
) -> None:
    """
    Background task: poll for approval_response, then act:
      - approved  -> transition to active, spawn EXECUTION pass
      - rejected  -> transition to failed
      - timeout   -> transition to failed
    """
    bootstrap_completed_at = datetime.now(timezone.utc)

    await post_json_to_feed(session_id, {
        "kind": "listen_chain_start",
        "session_id": session_id,
        "waiting_for": "approval_response",
    })

    row = await _wait_for_approval(session_id, after=bootstrap_completed_at)

    if row is None:
        # Timeout
        await update_session(session_id, status="failed", failure_reason="approval timeout after 30 minutes")
        await post_json_to_feed(session_id, {
            "kind": "approval_timeout",
            "session_id": session_id,
        })
        return

    # Parse approval content
    import json
    content_raw = row.get("content", "{}")
    try:
        content = json.loads(content_raw) if isinstance(content_raw, str) else content_raw
    except json.JSONDecodeError:
        content = {"approved": False, "reason": content_raw}

    approved: bool = content.get("approved", False)
    reason: str = content.get("reason", "")

    if not approved:
        await update_session(session_id, status="failed", failure_reason=f"rejected: {reason}")
        await post_json_to_feed(session_id, {
            "kind": "approval_rejected",
            "session_id": session_id,
            "reason": reason,
        })
        return

    # Approved — spawn EXECUTION pass resuming the bootstrap Claude session
    await update_session(session_id, status="active")
    await post_json_to_feed(session_id, {
        "kind": "approval_granted",
        "session_id": session_id,
        "reason": reason,
    })

    execution_instruction = (
        "APPROVAL GRANTED. Proceed with the implementation plan you outlined.\n"
        "You may now write, edit, and commit code as needed.\n"
        "When complete, summarise what was done."
    )

    task_id = await spawn_code_task(
        instruction=execution_instruction,
        working_dir=working_dir,
        session_id=session_id,
        model=model,
        resume_claude_session_id=claude_session_id,
        max_turns=50,
        budget_usd=10.0,
        timeout_seconds=1800,
    )

    await post_json_to_feed(session_id, {
        "kind": "execution_started",
        "session_id": session_id,
        "task_id": task_id,
    })
