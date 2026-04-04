"""
asyncpg connection pool and DB helper functions.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

import asyncpg

import config

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    """Return singleton asyncpg connection pool, creating it on first call."""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(config.OPS_DB_URL, min_size=1, max_size=10)
    return _pool


async def log_step(
    session_id: str,
    message: str,
    msg_type: str = "execution_log",
    role: str = "container",
) -> None:
    """Insert a message row into session_messages."""
    pool = await get_pool()
    message_id = f"ct-{int(time.time() * 1000)}"
    now = datetime.now(timezone.utc)
    await pool.execute(
        """
        INSERT INTO session_messages
            (message_id, session_id, role, content, message_type, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        message_id,
        session_id,
        role,
        message,
        msg_type,
        now,
    )


async def get_session(session_id: str) -> dict[str, Any] | None:
    """Fetch a session row by ID. Returns dict or None."""
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT * FROM sessions WHERE session_id = $1", session_id
    )
    if row is None:
        return None
    return dict(row)


async def update_session(session_id: str, **fields: Any) -> None:
    """UPDATE sessions SET field=value, ... WHERE session_id = $N."""
    if not fields:
        return
    pool = await get_pool()
    set_clauses = ", ".join(
        f"{key} = ${i + 1}" for i, key in enumerate(fields)
    )
    values = list(fields.values())
    values.append(session_id)
    await pool.execute(
        f"UPDATE sessions SET {set_clauses} WHERE session_id = ${len(values)}",
        *values,
    )


async def get_project(project_id: str) -> dict[str, Any] | None:
    """Fetch a project row by ID. Returns dict or None."""
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT * FROM projects WHERE project_id = $1", project_id
    )
    if row is None:
        return None
    return dict(row)
