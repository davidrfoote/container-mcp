"""
Spawns the Claude CLI as an async subprocess and parses its streaming JSON output.
All output events are posted to session_messages for display in dev-session-app.

Includes:
  - Same-task retry with failover chain (on rate limit / quota / auth errors)
  - Rules file loading (base.md + project.md + task_rules)
  - MCP config injection (gitnexus)
  - active_task_id tracking in sessions table
  - cli_model persistence
  - tool_use / tool_result streaming to session feed
  - session_update emissions
  - Per-model env overrides from chain resolution
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
from asyncio.subprocess import PIPE
from pathlib import Path
from typing import Any
from uuid import uuid4

from feed import post_json_to_feed, post_to_feed
from model_registry import (
    FallbackChain,
    ResolvedModel,
    resolve_chain,
    resolve_model,
    report_model_failure,
    report_model_success,
)

# ── Error keywords that trigger retry with next account ─────────────────
_RETRYABLE_ERRORS = ("rate_limit", "overloaded", "quota", "authentication",
                      "invalid_api_key", "429", "capacity", "throttl")

# ── Dev user for rules file paths ───────────────────────────────────────
DEV_USER = os.getenv("DEV_USER", "david")


# ═══════════════════════════════════════════════════════════════════════════
# CLI arg + env building
# ═══════════════════════════════════════════════════════════════════════════

def _resolve_claude_bin() -> str:
    candidates = [
        os.getenv("CLAUDE_BIN"),
        f"/home/{DEV_USER}/.npm-local/bin/claude",
        "/home/openclaw/.npm-global/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
    ]
    for c in candidates:
        if not c:
            continue
        try:
            if os.access(c, os.X_OK):
                return c
        except OSError:
            continue
    return "claude"


def _build_args(
    instruction: str,
    resolved: ResolvedModel,
    max_turns: int,
    budget_usd: float,
    effort: str | None,
    allowed_tools: list[str] | None,
    resume_claude_session_id: str | None,
    rules_file: str | None,
    mcp_config_file: str | None,
    agents: str | None,
    allowed_dirs: list[str] | None,
    debug_file: str | None,
) -> list[str]:
    args = [
        _resolve_claude_bin(),
        "-p", instruction,
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "acceptEdits",
        "--max-turns", str(max_turns),
        "--max-budget-usd", str(budget_usd),
        "--model", resolved.model,
    ]

    if debug_file:
        args += ["--debug-file", debug_file]
    if effort:
        args += ["--effort", effort]
    if agents:
        args += ["--agents", agents]
    if allowed_tools:
        args += ["--allowed-tools", ",".join(allowed_tools)]
    if resume_claude_session_id:
        args += ["--resume", resume_claude_session_id]
    if rules_file:
        args += ["--append-system-prompt-file", rules_file]
    if mcp_config_file:
        args += ["--mcp-config", mcp_config_file]
    if allowed_dirs:
        for d in allowed_dirs:
            args += ["--add-dir", d]

    return args


def _build_child_env(resolved: ResolvedModel) -> dict[str, str]:
    """Build subprocess env with model-specific overrides."""
    env = dict(os.environ)
    # Ensure clean PATH
    env["PATH"] = f"/home/openclaw/.npm-global/bin:/usr/local/bin:/usr/bin:/home/{DEV_USER}/.npm-local/bin:{env.get('PATH', '')}"
    # Clean up leaked env vars
    env.pop("CLAUDECODE", None)
    env.pop("CLAUDE_CODE_ENTRYPOINT", None)

    # Apply account-specific overrides
    for key, val in resolved.env_overrides.items():
        if val is None:
            env.pop(key, None)
        else:
            env[key] = val
    return env


# ═══════════════════════════════════════════════════════════════════════════
# Rules file handling (TS parity)
# ═══════════════════════════════════════════════════════════════════════════

def _load_rules(working_dir: str, task_rules: str | None) -> tuple[str, str | None]:
    """Load base + project rules. Returns (rules_content, temp_file_path)."""
    rules = ""

    # Base rules
    base_path = f"/home/{DEV_USER}/.rules/base.md"
    try:
        rules += Path(base_path).read_text() + "\n"
    except (FileNotFoundError, OSError):
        pass

    # Project rules
    proj_path = Path(working_dir) / ".rules" / "project.md"
    try:
        rules += proj_path.read_text() + "\n"
    except (FileNotFoundError, OSError):
        pass

    # Task-specific rules
    if task_rules:
        rules += task_rules + "\n"

    rules = rules.strip()
    if not rules:
        return "", None

    # Write to temp file
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".md", prefix="cmcp-rules-", delete=False)
    tmp.write(rules)
    tmp.close()
    return rules, tmp.name


def _build_mcp_config(task_id: str) -> tuple[str | None, str | None]:
    """Build MCP config for gitnexus if configured. Returns (config_path, config_content)."""
    gitnexus_url = os.getenv("GITNEXUS_SERVICE_URL")
    if not gitnexus_url:
        return None, None

    config = {
        "mcpServers": {
            "gitnexus": {
                "type": "sse",
                "url": f"{gitnexus_url.rstrip('/')}/sse",
            }
        }
    }
    config_str = json.dumps(config, indent=2)

    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", prefix=f"mcp-config-{task_id}-", delete=False)
    tmp.write(config_str)
    tmp.close()
    return tmp.name, config_str


# ═══════════════════════════════════════════════════════════════════════════
# Event handling (TS parity — full streaming)
# ═══════════════════════════════════════════════════════════════════════════

# In-memory task log (for get_task_log tool)
_task_logs: dict[str, list[str]] = {}


def _task_log(task_id: str, line: str) -> None:
    if task_id not in _task_logs:
        _task_logs[task_id] = []
    _task_logs[task_id].append(line)
    # Cap at 10K lines
    if len(_task_logs[task_id]) > 10000:
        _task_logs[task_id] = _task_logs[task_id][-5000:]


def get_task_log(task_id: str) -> list[str]:
    return _task_logs.get(task_id, [])


async def _handle_event(
    event: dict[str, Any],
    task_id: str,
    session_id: str | None,
    db_pool: Any = None,
) -> dict[str, Any]:
    """Parse a single CLI JSON event. Returns metadata (cost, tokens, etc)."""
    result: dict[str, Any] = {}
    ev_type = event.get("type")

    # ── system init ─────────────────────────────────────────────────────
    if ev_type == "system" and event.get("subtype") == "init":
        cli_model = event.get("model")
        version = event.get("claude_code_version")
        perm_mode = event.get("permissionMode")
        tools = event.get("tools", [])
        mcp_servers_raw = event.get("mcp_servers", [])
        mcp_servers = []
        for s in mcp_servers_raw:
            if isinstance(s, str):
                mcp_servers.append(s)
            elif isinstance(s, dict):
                mcp_servers.append(s.get("name") or s.get("id") or str(s))

        # Persist model to sessions table
        if cli_model and session_id and db_pool:
            try:
                await db_pool.execute(
                    "UPDATE sessions SET model = $1, cli_model = $1, updated_at = now() WHERE session_id = $2",
                    cli_model, session_id,
                )
                # Notify session status channel
                safe_id = session_id.replace("-", "_")
                await db_pool.execute("SELECT pg_notify($1, $2)", [
                    f"session_status_{safe_id}",
                    json.dumps({"session_id": session_id, "model": cli_model}),
                ])
            except Exception:
                pass

        if session_id:
            mcp_str = ", ".join(mcp_servers) if mcp_servers else "none"
            await post_to_feed(
                session_id,
                f"⚙️ Claude Code v{version or '?'} · Model: {cli_model or '?'} · Mode: {perm_mode or '?'} · MCP: {mcp_str} · {len(tools)} tools",
                role="coding_agent", msg_type="console",
            )
            await post_json_to_feed(session_id, {
                "kind": "runtime_init",
                "taskId": task_id,
                "model": cli_model,
                "version": version,
                "permissionMode": perm_mode,
                "mcpServers": mcp_servers,
                "tools": tools,
            })

    # ── assistant turn ──────────────────────────────────────────────────
    elif ev_type == "assistant":
        message = event.get("message", {})
        for block in message.get("content", []):
            block_type = block.get("type")

            if block_type == "tool_use":
                tool_name = block.get("name", "?")
                args_str = json.dumps(block.get("input", {}))[:600]
                tool_id = block.get("id", "")

                if session_id:
                    await post_to_feed(
                        session_id,
                        f"🔧 `{tool_name}` {args_str}",
                        role="coding_agent", msg_type="execution_log",
                    )
                    await post_json_to_feed(session_id, {
                        "kind": "tool_active",
                        "taskId": task_id,
                        "toolName": tool_name,
                        "toolId": tool_id,
                        "inputSummary": args_str[:300],
                    })
                    # Subagent detection
                    if tool_name == "Task":
                        inp = block.get("input", {})
                        await post_json_to_feed(session_id, {
                            "kind": "subagent_spawn",
                            "taskId": task_id,
                            "toolId": tool_id,
                            "description": inp.get("description", ""),
                            "prompt": str(inp.get("prompt", ""))[:500],
                        })

            elif block_type == "text":
                text = (block.get("text") or "").strip()
                if text and len(text) > 20 and session_id:
                    await post_to_feed(
                        session_id, f"💭 {text[:1500]}",
                        role="coding_agent", msg_type="execution_log",
                    )

    # ── user turn (tool results) ────────────────────────────────────────
    elif ev_type == "user":
        for block in event.get("message", {}).get("content", []):
            if block.get("type") == "tool_result":
                is_error = block.get("is_error", False)
                raw = block.get("content", "")
                if isinstance(raw, str):
                    result_text = raw
                elif isinstance(raw, list):
                    result_text = "".join(
                        c.get("text", "") for c in raw if c.get("type") == "text"
                    )
                else:
                    result_text = str(raw)
                truncated = result_text[:2000]
                if truncated and session_id:
                    icon = "❌" if is_error else "📄"
                    await post_to_feed(
                        session_id, f"{icon} {truncated}",
                        role="coding_agent", msg_type="execution_log",
                    )

    # ── rate limit event ────────────────────────────────────────────────
    elif ev_type == "rate_limit_event":
        info = event.get("rate_limit_info", {})
        if info.get("status") == "blocked" and session_id:
            resets_at = info.get("resetsAt", "unknown")
            if isinstance(resets_at, (int, float)):
                from datetime import datetime, timezone
                resets_at = datetime.fromtimestamp(resets_at, tz=timezone.utc).isoformat()
            await post_to_feed(
                session_id,
                f"⏸️ Rate limited ({info.get('rateLimitType', 'unknown')}) — resets at {resets_at}",
                role="system", msg_type="console",
            )

    # ── result ──────────────────────────────────────────────────────────
    elif ev_type == "result":
        result["cost_usd"] = event.get("total_cost_usd", event.get("cost_usd", 0.0))
        result["total_input_tokens"] = event.get("usage", {}).get("input_tokens", 0)
        result["total_output_tokens"] = event.get("usage", {}).get("output_tokens", 0)
        result["claude_session_id"] = event.get("session_id")
        result["subtype"] = event.get("subtype", "unknown")
        result["is_error"] = event.get("is_error", False)
        result["num_turns"] = event.get("num_turns", 0)
        result["duration_ms"] = event.get("duration_ms", 0)

        model_usage = event.get("modelUsage")
        result["model_usage"] = model_usage

        # Persist claude session ID
        claude_sid = result["claude_session_id"]
        if claude_sid and session_id and db_pool:
            try:
                await db_pool.execute(
                    "UPDATE sessions SET claude_session_id = $1, updated_at = now() WHERE session_id = $2",
                    claude_sid, session_id,
                )
            except Exception:
                pass

        # Build summary
        subtype = result["subtype"]
        is_error = result["is_error"]
        icon = "❌" if is_error else ("⚠️" if subtype == "interrupted" else ("⏱️" if subtype == "timeout" else "✅"))
        parts = [f"{icon} Task {subtype}"]
        if result["duration_ms"]:
            parts.append(f"{result['duration_ms'] / 1000:.1f}s")
        if result["num_turns"]:
            parts.append(f"{result['num_turns']} turn{'s' if result['num_turns'] != 1 else ''}")
        if result["cost_usd"]:
            parts.append(f"${result['cost_usd']:.4f}")

        if model_usage:
            breakdown = ", ".join(
                f"{m}: ${u.get('costUSD', 0):.4f}" for m, u in model_usage.items()
            )
            if breakdown:
                parts.append(f"[{breakdown}]")

        summary = " · ".join(parts)
        output_text = event.get("result") or event.get("output") or ""
        if output_text:
            summary += f"\n\n{output_text[:3000]}"

        if session_id:
            await post_to_feed(session_id, summary)

        # Update session stats
        if session_id and db_pool and result["cost_usd"]:
            try:
                total_tokens = result["total_input_tokens"] + result["total_output_tokens"]
                await db_pool.execute(
                    """UPDATE sessions
                       SET token_usage = COALESCE(token_usage, 0) + $1,
                           cost_usd = COALESCE(cost_usd, 0) + $2,
                           num_turns = COALESCE(num_turns, 0) + $3,
                           task_duration_ms = COALESCE(task_duration_ms, 0) + $4,
                           updated_at = now()
                       WHERE session_id = $5""",
                    total_tokens, result["cost_usd"], result["num_turns"],
                    result["duration_ms"], session_id,
                )
            except Exception:
                pass

    return result


# ═══════════════════════════════════════════════════════════════════════════
# Core task runner (single attempt)
# ═══════════════════════════════════════════════════════════════════════════

async def _run_task_once(
    task_id: str,
    instruction: str,
    working_dir: str,
    resolved: ResolvedModel,
    child_env: dict[str, str],
    session_id: str | None,
    db_pool: Any,
    timeout_seconds: int,
    max_turns: int,
    budget_usd: float,
    effort: str | None,
    allowed_tools: list[str] | None,
    resume_claude_session_id: str | None,
    rules_file: str | None,
    mcp_config_file: str | None,
    agents: str | None,
    allowed_dirs: list[str] | None,
) -> dict[str, Any]:
    """Run one attempt. Returns result dict with 'success' and 'retryable' flags."""
    debug_file = f"/tmp/task-{task_id}-debug.log"

    args = _build_args(
        instruction=instruction,
        resolved=resolved,
        max_turns=max_turns,
        budget_usd=budget_usd,
        effort=effort,
        allowed_tools=allowed_tools,
        resume_claude_session_id=resume_claude_session_id,
        rules_file=rules_file,
        mcp_config_file=mcp_config_file,
        agents=agents,
        allowed_dirs=allowed_dirs,
        debug_file=debug_file,
    )

    stderr_lines: list[str] = []
    result: dict[str, Any] = {"success": False, "retryable": False}

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=working_dir,
            stdout=PIPE,
            stderr=PIPE,
            env=child_env,
        )

        async def _read_stderr():
            assert proc.stderr
            buf = ""
            async for raw in proc.stderr:
                text = raw.decode(errors="replace")
                buf += text
                if "\n" in buf:
                    lines, buf = buf.rsplit("\n", 1)
                    for line in lines.split("\n"):
                        line = line.strip()
                        if line:
                            stderr_lines.append(line)
                            _task_log(task_id, f"[stderr] {line}")
                            if session_id:
                                await post_to_feed(
                                    session_id, f"⚠️ stderr: {line[:2000]}",
                                    role="system", msg_type="console",
                                )

        stderr_task = asyncio.create_task(_read_stderr())

        assert proc.stdout
        stdout_buf = ""
        try:
            async with asyncio.timeout(timeout_seconds):
                async for raw_line in proc.stdout:
                    stdout_buf += raw_line.decode(errors="replace")
                    # Split on newlines, keep last partial line
                    lines = stdout_buf.split("\n")
                    stdout_buf = lines.pop() or ""

                    for line in lines:
                        if not line.strip():
                            continue
                        _task_log(task_id, line)
                        try:
                            event = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        event_result = await _handle_event(event, task_id, session_id, db_pool)
                        # Merge result metadata
                        for k in ("cost_usd", "claude_session_id", "subtype", "is_error",
                                   "num_turns", "duration_ms", "total_input_tokens",
                                   "total_output_tokens", "model_usage"):
                            if k in event_result:
                                result[k] = event_result[k]

        except TimeoutError:
            proc.kill()
            result["timeout"] = True
            if session_id:
                await post_to_feed(
                    session_id,
                    f"[task_id={task_id}] timed out after {timeout_seconds}s",
                    msg_type="execution_log",
                )

        await proc.wait()
        await stderr_task

        result["exit_code"] = proc.returncode
        result["success"] = proc.returncode == 0

        stderr_text = "\n".join(stderr_lines)

        if proc.returncode == 0:
            report_model_success(resolved.account_id, result.get("cost_usd", 0),
                                 result.get("total_input_tokens", 0) + result.get("total_output_tokens", 0))
        else:
            lower = stderr_text.lower()
            if any(kw in lower for kw in _RETRYABLE_ERRORS):
                result["retryable"] = True
                report_model_failure(resolved.account_id, stderr_text[:500])
            else:
                report_model_success(resolved.account_id, 0)  # Process ran fine, code might have failed

        if session_id:
            await post_to_feed(
                session_id,
                f"✅ Process {task_id} exited with code {proc.returncode}. Debug log: {debug_file}",
            )

    except Exception as exc:
        result["error"] = str(exc)
        result["retryable"] = False
        if session_id:
            await post_to_feed(
                session_id,
                f"❌ Task {task_id} failed to start: {exc}",
            )

    return result


# ═══════════════════════════════════════════════════════════════════════════
# Task spawner with retry chain
# ═══════════════════════════════════════════════════════════════════════════

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
    agents: str | None = None,
    allowed_dirs: list[str] | None = None,
    max_retries: int = 3,
) -> str:
    """
    Spawn a coding task with automatic failover retry.

    On retryable errors (rate limit, auth, quota), retries with the next
    account in the fallback chain. Returns task_id immediately.
    """
    task_id = str(uuid4())

    # Resolve chain for this model hint
    chain = resolve_chain(model)
    resolved = resolve_model(model)

    # ── Load rules ──────────────────────────────────────────────────────
    rules_content, rules_file = _load_rules(working_dir, task_rules)

    # ── Build MCP config ────────────────────────────────────────────────
    mcp_config_file, _ = _build_mcp_config(task_id)

    # ── Emit task_start ─────────────────────────────────────────────────
    if session_id:
        await post_to_feed(
            session_id,
            f"🚀 Starting code task ({task_id}) [{resolved.model}] via {resolved.account_id}"
            f"{' [resumed]' if resume_claude_session_id else ''}\n\n{instruction[:400]}",
        )
        await post_json_to_feed(session_id, {
            "kind": "task_start",
            "taskId": task_id,
            "model": resolved.model,
            "accountId": resolved.account_id,
            "provider": resolved.provider,
            "tier": resolved.tier,
            "effort": effort,
            "allowedTools": allowed_tools or [],
            "agents": agents,
            "isResumed": bool(resume_claude_session_id),
            "workingDir": working_dir,
            "rules": rules_content[:4000],
        })

    # ── Set active_task_id ──────────────────────────────────────────────
    db_pool = None
    if session_id:
        try:
            from db import get_pool
            db_pool = await get_pool()
            await db_pool.execute(
                "UPDATE sessions SET active_task_id = $1, task_started_at = now(), updated_at = now() WHERE session_id = $2",
                task_id, session_id,
            )
        except Exception:
            pass

    # ── Fire off the background task with retry ─────────────────────────
    async def _run_with_retry():
        nonlocal resolved, db_pool
        current_resolved = resolved
        tried_accounts: list[str] = [current_resolved.account_id]
        last_error: str | None = None

        for attempt in range(max_retries):
            child_env = _build_child_env(current_resolved)

            result = await _run_task_once(
                task_id=task_id,
                instruction=instruction,
                working_dir=working_dir,
                resolved=current_resolved,
                child_env=child_env,
                session_id=session_id,
                db_pool=db_pool,
                timeout_seconds=timeout_seconds,
                max_turns=max_turns,
                budget_usd=budget_usd,
                effort=effort,
                allowed_tools=allowed_tools,
                resume_claude_session_id=resume_claude_session_id,
                rules_file=rules_file,
                mcp_config_file=mcp_config_file,
                agents=agents,
                allowed_dirs=allowed_dirs,
            )

            if result.get("success"):
                break

            if not result.get("retryable"):
                break

            # Retry with next account in chain
            last_error = result.get("error", "unknown")
            next_slot = None
            if chain:
                for slot in chain.slots:
                    if slot.account_id not in tried_accounts and slot.available:
                        next_slot = slot
                        break

            if not next_slot:
                if session_id:
                    await post_to_feed(
                        session_id,
                        f"❌ All accounts exhausted after {attempt + 1} attempts. Last error: {last_error}",
                    )
                break

            tried_accounts.append(next_slot.account_id)
            current_resolved = ResolvedModel(
                model=next_slot.model,
                account_id=next_slot.account_id,
                provider=next_slot.provider,
                tier=next_slot.tier,
                was_failover=True,
                failover_from=resolved.model,
                env_overrides=next_slot.env_overrides,
            )

            if session_id:
                await post_to_feed(
                    session_id,
                    f"🔄 Retrying with {next_slot.account_id} ({next_slot.model}) — attempt {attempt + 2}/{max_retries}",
                    role="system", msg_type="console",
                )
                await post_json_to_feed(session_id, {
                    "kind": "failover",
                    "taskId": task_id,
                    "fromAccount": tried_accounts[-2],
                    "toAccount": next_slot.account_id,
                    "toModel": next_slot.model,
                    "attempt": attempt + 2,
                    "error": last_error,
                })

        # ── Cleanup ─────────────────────────────────────────────────────
        if rules_file:
            try:
                os.unlink(rules_file)
            except OSError:
                pass
        if mcp_config_file:
            try:
                os.unlink(mcp_config_file)
            except OSError:
                pass

        # Clear active_task_id
        if session_id and db_pool:
            try:
                await db_pool.execute(
                    "UPDATE sessions SET active_task_id = NULL, task_started_at = NULL, updated_at = now() WHERE session_id = $1 AND active_task_id = $2",
                    session_id, task_id,
                )
            except Exception:
                pass

    asyncio.create_task(_run_with_retry())
    return task_id
