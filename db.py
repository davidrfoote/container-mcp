"""
asyncpg connection pool and DB helper functions.
"""
from __future__ import annotations

import json
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
    role: str = "container",
) -> None:
    """Insert a message row into session_messages and emit pg_notify."""
    pool = await get_pool()
    message_id = f"ct-{int(time.time() * 1000)}"
    now = datetime.now(timezone.utc)
    row = await pool.fetchrow(
        """INSERT INTO session_messages
               (message_id, session_id, role, content, message_type, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING message_id""",
        message_id, session_id, role, message, msg_type, now,
    )
    if row:
        notify_payload = json.dumps({
            "id": row["message_id"], "message_id": row["message_id"],
            "session_id": session_id, "role": role,
            "message_type": msg_type, "content": message,
            "created_at": now.isoformat(),
        })
        safe_id = session_id.replace("-", "_")
        for channel in [f"session_messages_{safe_id}", "session_messages", f"session:{session_id}"]:
            try:
                await pool.execute("SELECT pg_notify($1, $2)", channel, notify_payload)
            except Exception:
                pass
