"""
Helpers for posting content to the session message feed (session_messages table).
"""
from __future__ import annotations

import json

from db import log_step


async def post_to_feed(
    session_id: str,
    content: str,
    role: str = "system",
    msg_type: str = "console",
) -> None:
    """Post a plain-text message to the session feed."""
    await log_step(session_id, content, msg_type=msg_type, role=role)


async def post_json_to_feed(
    session_id: str,
    data: dict,
    role: str = "system",
    msg_type: str = "cli_context",
) -> None:
    """Serialise data as JSON and post to the session feed."""
    await post_to_feed(session_id, json.dumps(data), role=role, msg_type=msg_type)
