"""
asyncpg connection pool and DB helper functions.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

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
        "container",
        message,
        msg_type,
        now,
    )
