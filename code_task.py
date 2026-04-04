"""
Spawns the Claude CLI as an async subprocess and parses its streaming JSON output.
All output events are posted to session_messages for display in dev-session-app.

Claude CLI JSON event types we handle:
  {"type": "system", "subtype": "init", "model": "...", "session_id": "..."}
  {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}}
  {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "...", "input": {...}}]}}
  {"type": "result", "subtype": "success"|"error", "cost_usd": N,
   "total_input_tokens": N, "total_output_tokens": N, "session_id": "..."}
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
from asyncio.subprocess import PIPE
from typing import Any
from uuid import uuid4

from db import update_session
from feed import post_json_to_feed, post_to_feed
from model_registry import ResolvedModel, report_model_failure, report_model_success, resolve_model

_ERROR_KEYWORDS = ("rate_limit", "overloaded", "quota", "authentication", "invalid_api_key")


def _build_args(
    instruction: str,
    resolved: ResolvedModel,
    max_turns: int,
    budget_usd: float,
    effort: str | None,
    allowed_tools: list[str] | None,
    resume_claude_session_id: str | None,
    task_rules_file: str | None,
) -> list[str]:
    args = [
        "claude", "-p", instruction,
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "acceptEdits",
        "--max-turns", str(max_turns),
        "--max-budget-usd", str(budget_usd),
        "--model", resolved.id,
    ]
    if effort:
        args += ["--effort", effort]
    if allowed_tools:
        args += ["--allowed-tools", ",".join(allowed_tools)]
    if resume_claude_session_id:
        args += ["--resume", resume_claude_session_id]
    if task_rules_file:
        args += ["--append-system-prompt-file", task_rules_file]
    return args


def _build_child_env(resolved: ResolvedModel) -> dict[str, str]:
    env = dict(os.environ)
    for key, val in resolved.env_overrides.items():
        if val is None:
            env.pop(key, None)
        else:
            env[key] = val
    return env


async def _handle_event(event: dict[str, Any], session_id: str | None) -> dict[str, Any]:
    """
    Parse a single Claude CLI JSON event. Returns captured metadata (cost, tokens, etc.).
    Posts updates to feed if session_id is set.
    """
    result: dict[str, Any] = {}
    ev_type = event.get("type")

    if ev_type == "system" and event.get("subtype") == "init":
        if session_id:
            await post_json_to_feed(session_id, {
                "kind": "runtime_init",
                "model": event.get("model"),
                "session_id": event.get("session_id"),
            })

    elif ev_type == "assistant":
        message = event.get("message", {})
        content_blocks = message.get("content", [])
        for block in content_blocks:
            block_type = block.get("type")
            if block_type == "text" and session_id:
                await post_to_feed(session_id, block.get("text", ""), msg_type="execution_update")
            elif block_type == "tool_use" and session_id:
                await post_json_to_feed(session_id, {
                    "kind": "tool_use",
                    "name": block.get("name"),
                    "input": block.get("input", {}),
                }, msg_type="execution_update")

    elif ev_type == "result":
        result["cost_usd"] = event.get("cost_usd", 0.0)
        result["total_input_tokens"] = event.get("total_input_tokens", 0)
        result["total_output_tokens"] = event.get("total_output_tokens", 0)
        result["claude_session_id"] = event.get("session_id")
        result["subtype"] = event.get("subtype", "unknown")
        if session_id:
            await post_json_to_feed(session_id, {
                "kind": "task_complete",
                "subtype": result["subtype"],
                "cost_usd": result["cost_usd"],
                "total_input_tokens": result["total_input_tokens"],
                "total_output_tokens": result["total_output_tokens"],
                "claude_session_id": result["claude_session_id"],
            })

    return result


async def _run_task(
    task_id: str,
    args: list[str],
    working_dir: str,
    child_env: dict[str, str],
    session_id: str | None,
    resolved: ResolvedModel,
    timeout_seconds: int,
    task_rules_file: str | None,
) -> None:
    """Background task: run Claude CLI process, stream output, update DB."""
    stderr_lines: list[str] = []
    captured: dict[str, Any] = {}

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=working_dir,
            stdout=PIPE,
            stderr=PIPE,
            env=child_env,
        )

        async def _read_stderr() -> None:
            assert proc.stderr
            async for line in proc.stderr:
                stderr_lines.append(line.decode(errors="replace").rstrip())

        stderr_task = asyncio.create_task(_read_stderr())

        assert proc.stdout
        try:
            async with asyncio.timeout(timeout_seconds):
                async for raw_line in proc.stdout:
                    line = raw_line.decode(errors="replace").strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue  # skip malformed lines
                    meta = await _handle_event(event, session_id)
                    captured.update({k: v for k, v in meta.items() if v is not None})
        except TimeoutError:
            proc.kill()
            if session_id:
                await post_to_feed(session_id, f"[task_id={task_id}] timed out after {timeout_seconds}s", msg_type="execution_log")

        await proc.wait()
        await stderr_task

        stderr_text = "\n".join(stderr_lines)

        if proc.returncode == 0:
            report_model_success(resolved.id, resolved.auth_tier)
        else:
            lower_stderr = stderr_text.lower()
            if any(kw in lower_stderr for kw in _ERROR_KEYWORDS):
                report_model_failure(resolved.id, resolved.auth_tier, stderr_text[:200])
            if session_id:
                await post_to_feed(
                    session_id,
                    f"[task_id={task_id}] process exited rc={proc.returncode}\n{stderr_text[:500]}",
                    msg_type="execution_log",
                )

        # Persist cost/tokens to session
        if session_id and captured:
            update_fields: dict[str, Any] = {}
            if "cost_usd" in captured:
                update_fields["last_cost_usd"] = captured["cost_usd"]
            if "total_input_tokens" in captured:
                update_fields["last_input_tokens"] = captured["total_input_tokens"]
            if "total_output_tokens" in captured:
                update_fields["last_output_tokens"] = captured["total_output_tokens"]
            if "claude_session_id" in captured:
                update_fields["claude_session_id"] = captured["claude_session_id"]
            if update_fields:
                await update_session(session_id, **update_fields)

    finally:
        if task_rules_file and os.path.exists(task_rules_file):
            try:
                os.unlink(task_rules_file)
            except OSError:
                pass


async def spawn_code_task(
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
) -> str:
    """
    Spawns claude CLI, streams output, posts to session feed.
    Returns task_id immediately (non-blocking — fires and forgets into asyncio task).
    """
    task_id = str(uuid4())
    resolved = resolve_model(model)

    # Write task_rules to temp file if provided
    task_rules_file: str | None = None
    if task_rules:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".md", prefix="task_rules_", delete=False
        ) as f:
            f.write(task_rules)
            task_rules_file = f.name

    args = _build_args(
        instruction=instruction,
        resolved=resolved,
        max_turns=max_turns,
        budget_usd=budget_usd,
        effort=effort,
        allowed_tools=allowed_tools,
        resume_claude_session_id=resume_claude_session_id,
        task_rules_file=task_rules_file,
    )
    child_env = _build_child_env(resolved)

    if session_id:
        await post_json_to_feed(session_id, {
            "kind": "task_start",
            "task_id": task_id,
            "model": resolved.id,
            "model_alias": model,
            "model_was_failover": resolved.was_failover,
            "failover_from": resolved.failover_from,
            "working_dir": working_dir,
        })

    asyncio.create_task(
        _run_task(
            task_id=task_id,
            args=args,
            working_dir=working_dir,
            child_env=child_env,
            session_id=session_id,
            resolved=resolved,
            timeout_seconds=timeout_seconds,
            task_rules_file=task_rules_file,
        )
    )

    return task_id
