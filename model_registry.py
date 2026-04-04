"""
Model registry — catalog, alias resolution, health tracking, and failover.

Auth tiers:
  oauth  — uses Claude CLI via OAuth (delete ANTHROPIC_API_KEY from env)
  api    — uses Claude CLI with ANTHROPIC_API_KEY in env
  compat — uses OpenAI-compatible endpoint (set ANTHROPIC_BASE_URL + key)
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import httpx

import config

HEALTH_TTL_SECONDS = 300  # 5 minutes


@dataclass
class ModelDef:
    id: str
    aliases: list[str]
    priority: int
    auth_tier: str  # "oauth" | "api" | "compat"
    fallback_to: list[str]
    cost_hint: str  # "low" | "medium" | "high"


@dataclass
class ResolvedModel:
    id: str
    auth_tier: str
    was_failover: bool
    failover_from: str | None
    env_overrides: dict[str, str | None]  # None means delete the key


# ---------------------------------------------------------------------------
# Build catalog
# ---------------------------------------------------------------------------

def _build_catalog() -> list[ModelDef]:
    catalog: list[ModelDef] = [
        ModelDef(
            id="claude-sonnet-4-6",
            aliases=["sonnet", "default", "balanced", "coding", "standard"],
            priority=1,
            auth_tier="oauth",
            fallback_to=["claude-haiku-4-5-20251001", "claude-opus-4-6"],
            cost_hint="medium",
        ),
        ModelDef(
            id="claude-haiku-4-5-20251001",
            aliases=["haiku", "fast", "quick", "light"],
            priority=2,
            auth_tier="oauth",
            fallback_to=["claude-sonnet-4-6"],
            cost_hint="low",
        ),
        ModelDef(
            id="claude-opus-4-6",
            aliases=["opus", "smart", "powerful", "complex", "deep"],
            priority=3,
            auth_tier="oauth",
            fallback_to=["claude-sonnet-4-6"],
            cost_hint="high",
        ),
        ModelDef(
            id="claude-sonnet-4-6",
            aliases=["sonnet-api"],
            priority=10,
            auth_tier="api",
            fallback_to=["claude-haiku-4-5-20251001"],
            cost_hint="medium",
        ),
        ModelDef(
            id="claude-haiku-4-5-20251001",
            aliases=["haiku-api"],
            priority=11,
            auth_tier="api",
            fallback_to=[],
            cost_hint="low",
        ),
    ]
    if config.OPENAI_BASE_URL:
        catalog.append(
            ModelDef(
                id=config.OPENAI_MODEL,
                aliases=["compat", "external", "glm"],
                priority=20,
                auth_tier="compat",
                fallback_to=[],
                cost_hint="low",
            )
        )
    return sorted(catalog, key=lambda m: m.priority)


CATALOG: list[ModelDef] = _build_catalog()

# Health state: (model_id, auth_tier) -> {"available": bool, "expires_at": float, "error": str}
_health: dict[tuple[str, str], dict[str, Any]] = {}


# ---------------------------------------------------------------------------
# Health helpers
# ---------------------------------------------------------------------------

def _is_healthy(model_id: str, auth_tier: str) -> bool:
    key = (model_id, auth_tier)
    entry = _health.get(key)
    if entry is None:
        return True  # unknown = assume healthy
    if time.time() > entry["expires_at"]:
        return True  # TTL expired = reset to healthy
    return entry["available"]


def report_model_failure(model_id: str, auth_tier: str, error: str) -> None:
    """Mark a model as unavailable for HEALTH_TTL_SECONDS."""
    _health[(model_id, auth_tier)] = {
        "available": False,
        "expires_at": time.time() + HEALTH_TTL_SECONDS,
        "error": error,
    }


def report_model_success(model_id: str, auth_tier: str) -> None:
    """Mark a model as available (clear any failure state)."""
    _health[(model_id, auth_tier)] = {
        "available": True,
        "expires_at": time.time() + HEALTH_TTL_SECONDS,
        "error": "",
    }


# ---------------------------------------------------------------------------
# Env overrides per tier
# ---------------------------------------------------------------------------

def _env_overrides(auth_tier: str) -> dict[str, str | None]:
    if auth_tier == "oauth":
        return {"ANTHROPIC_API_KEY": None}  # None = delete from env
    if auth_tier == "compat":
        return {
            "ANTHROPIC_BASE_URL": config.OPENAI_BASE_URL or "",
            "ANTHROPIC_API_KEY": config.OPENAI_API_KEY or "",
        }
    # api tier — keep env as-is
    return {}


# ---------------------------------------------------------------------------
# resolve_model
# ---------------------------------------------------------------------------

def resolve_model(hint: str | None = None) -> ResolvedModel:
    """
    Resolve an alias/model-id/None to the best available model.

    Resolution order:
    1. Find matching ModelDef by alias (case-insensitive) or exact id.
    2. Build candidate list: [matched] + fallback models (OAuth tier preferred).
    3. Skip candidates where health shows unavailable and TTL not expired.
    4. Return first viable candidate as ResolvedModel.
    5. If all candidates are unhealthy, return the first candidate anyway
       (better to try than to silently fail).
    """
    matched: ModelDef | None = None

    if hint:
        hint_lower = hint.lower()
        for m in CATALOG:
            if m.id == hint or hint_lower in [a.lower() for a in m.aliases]:
                matched = m
                break

    if matched is None:
        # Default: first oauth sonnet
        for m in CATALOG:
            if m.id == config.DEFAULT_MODEL and m.auth_tier == "oauth":
                matched = m
                break
        if matched is None:
            matched = CATALOG[0]

    # Build candidate list
    candidates: list[ModelDef] = [matched]
    for fb_id in matched.fallback_to:
        # Prefer oauth tier for fallback, then api, then compat
        for tier in ("oauth", "api", "compat"):
            for m in CATALOG:
                if m.id == fb_id and m.auth_tier == tier and m not in candidates:
                    candidates.append(m)
                    break

    original_id = matched.id

    for candidate in candidates:
        if _is_healthy(candidate.id, candidate.auth_tier):
            was_failover = candidate is not matched
            return ResolvedModel(
                id=candidate.id,
                auth_tier=candidate.auth_tier,
                was_failover=was_failover,
                failover_from=original_id if was_failover else None,
                env_overrides=_env_overrides(candidate.auth_tier),
            )

    # All unhealthy — return first candidate and let it fail naturally
    return ResolvedModel(
        id=candidates[0].id,
        auth_tier=candidates[0].auth_tier,
        was_failover=False,
        failover_from=None,
        env_overrides=_env_overrides(candidates[0].auth_tier),
    )


# ---------------------------------------------------------------------------
# Status / probe
# ---------------------------------------------------------------------------

def get_model_status() -> list[dict]:
    """Return health and config for all registered models (for MCP tool)."""
    results = []
    for m in CATALOG:
        key = (m.id, m.auth_tier)
        entry = _health.get(key, {})
        ttl_expired = time.time() > entry.get("expires_at", 0)
        available = entry.get("available", True) if not ttl_expired else True
        results.append(
            {
                "id": m.id,
                "aliases": m.aliases,
                "priority": m.priority,
                "auth_tier": m.auth_tier,
                "cost_hint": m.cost_hint,
                "fallback_to": m.fallback_to,
                "available": available,
                "last_error": "" if available else entry.get("error", ""),
            }
        )
    return results


async def probe_models() -> list[dict]:
    """
    Actively probe each model tier for reachability.
    For oauth/api: check that the claude binary exists.
    For compat: HTTP GET the OPENAI_BASE_URL.
    Updates health state and returns status list.
    """
    import asyncio
    import shutil

    results = []

    async def _probe_claude(m: ModelDef) -> dict:
        binary = shutil.which("claude")
        if binary:
            report_model_success(m.id, m.auth_tier)
            return {"id": m.id, "auth_tier": m.auth_tier, "reachable": True}
        else:
            report_model_failure(m.id, m.auth_tier, "claude binary not found")
            return {"id": m.id, "auth_tier": m.auth_tier, "reachable": False, "error": "binary not found"}

    async def _probe_compat(m: ModelDef) -> dict:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(config.OPENAI_BASE_URL or "")
                report_model_success(m.id, m.auth_tier)
                return {"id": m.id, "auth_tier": m.auth_tier, "reachable": True, "status_code": resp.status_code}
        except Exception as exc:  # noqa: BLE001
            report_model_failure(m.id, m.auth_tier, str(exc))
            return {"id": m.id, "auth_tier": m.auth_tier, "reachable": False, "error": str(exc)}

    tasks = []
    for m in CATALOG:
        if m.auth_tier == "compat":
            tasks.append(_probe_compat(m))
        else:
            tasks.append(_probe_claude(m))

    results = await asyncio.gather(*tasks)
    return list(results)
