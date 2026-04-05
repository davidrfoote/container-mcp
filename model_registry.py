"""
Model registry — account-based failover chains with health + budget tracking.

Loads chain config from chains.yaml. Each chain is an ordered list of account slots.
On task failure (rate limit, auth, quota), the same task retries with the next slot.

Health and usage are persisted to ops-db so they survive restarts.
"""
from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import yaml

import config

# ── Where chains.yaml lives ─────────────────────────────────────────────
CHAINS_CONFIG_PATH = os.getenv(
    "CHAINS_CONFIG_PATH",
    "/etc/container-mcp/chains.yaml",
)

HEALTH_TTL_SECONDS = 300  # 5 min cache before re-probing


# ═══════════════════════════════════════════════════════════════════════════
# Data model
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class AccountSlot:
    """One account at one provider with one set of credentials."""
    account_id: str
    provider: str          # "anthropic" | "zai" | "minimax" | "deepseek"
    tier: str              # "sub" | "api"
    model: str             # model name passed to --model
    env_overrides: dict[str, str | None]  # None = delete from child env
    daily_budget_usd: float
    base_url: str | None = None  # for health probing

    # Runtime state (volatile, refreshed from DB)
    healthy: bool = True
    last_error: str = ""
    used_usd: float = 0.0
    last_check: float = 0.0

    @property
    def over_budget(self) -> bool:
        return self.used_usd >= self.daily_budget_usd

    @property
    def available(self) -> bool:
        return self.healthy and not self.over_budget


@dataclass
class FallbackChain:
    """Ordered list of account slots to walk on failure."""
    name: str
    slots: list[AccountSlot]

    def next_available(self) -> AccountSlot | None:
        """Return the first healthy, under-budget slot."""
        for slot in self.slots:
            if slot.available:
                return slot
        return None

    def all_slots(self) -> list[AccountSlot]:
        return list(self.slots)


@dataclass
class ResolvedModel:
    """What spawn_code_task actually uses."""
    model: str              # --model arg
    account_id: str         # which account was selected
    provider: str
    tier: str
    was_failover: bool
    failover_from: str | None
    env_overrides: dict[str, str | None]


# ═══════════════════════════════════════════════════════════════════════════
# Config loader
# ═══════════════════════════════════════════════════════════════════════════

_ENV_RE = re.compile(r"\$\{(\w+)\}")


def _resolve_env_vars(val: Any) -> Any:
    """Replace ${VAR} in strings with os.environ values."""
    if isinstance(val, str):
        def _sub(m: re.Match) -> str:
            return os.getenv(m.group(1), "")
        return _ENV_RE.sub(_sub, val)
    if isinstance(val, dict):
        return {k: _resolve_env_vars(v) for k, v in val.items()}
    if isinstance(val, list):
        return [_resolve_env_vars(v) for v in val]
    return val


def _load_config(config_path: str) -> dict:
    """Load and resolve chains.yaml."""
    p = Path(config_path)
    if not p.exists():
        return _builtin_config()
    with open(p) as f:
        raw = yaml.safe_load(f) or {}
    return _resolve_env_vars(raw)


def _builtin_config() -> dict:
    """Fallback if no chains.yaml exists — single Claude OAuth account."""
    return {
        "providers": {
            "anthropic": {
                "accounts": [{
                    "id": "claude-oauth-1",
                    "tier": "sub",
                    "model": "claude-sonnet-4-6",
                    "env_overrides": {"ANTHROPIC_API_KEY": None},
                    "daily_budget_usd": 40,
                }]
            }
        },
        "chains": {
            "sonnet": ["claude-oauth-1"],
            "glm": ["claude-oauth-1"],
            "minimax": ["claude-oauth-1"],
            "fast": ["claude-oauth-1"],
        },
        "aliases": {
            "default": "sonnet", "sonnet": "sonnet", "glm": "sonnet",
            "minimax": "sonnet", "fast": "sonnet",
        },
    }


def _build_registry(cfg: dict) -> tuple[dict[str, AccountSlot], dict[str, FallbackChain], dict[str, str]]:
    """Parse config into account map, chain map, and alias map."""
    # 1. Build accounts
    accounts: dict[str, AccountSlot] = {}
    for provider_name, provider_cfg in cfg.get("providers", {}).items():
        for acct_cfg in provider_cfg.get("accounts", []):
            slot = AccountSlot(
                account_id=acct_cfg["id"],
                provider=provider_name,
                tier=acct_cfg.get("tier", "api"),
                model=acct_cfg["model"],
                env_overrides=acct_cfg.get("env_overrides", {}),
                daily_budget_usd=acct_cfg.get("daily_budget_usd", 50.0),
                base_url=acct_cfg.get("base_url"),
            )
            # If base_url is set, inject ANTHROPIC_BASE_URL into env_overrides
            if slot.base_url and "ANTHROPIC_BASE_URL" not in slot.env_overrides:
                slot.env_overrides["ANTHROPIC_BASE_URL"] = slot.base_url
            accounts[slot.account_id] = slot

    # 2. Build chains
    chains: dict[str, FallbackChain] = {}
    for chain_name, account_ids in cfg.get("chains", {}).items():
        slots = []
        for aid in account_ids:
            if aid in accounts:
                slots.append(accounts[aid])
            else:
                import warnings
                warnings.warn(f"Chain '{chain_name}' references unknown account '{aid}'")
        chains[chain_name] = FallbackChain(name=chain_name, slots=slots)

    # 3. Build aliases
    aliases: dict[str, str] = {}
    for alias, chain_name in cfg.get("aliases", {}).items():
        aliases[alias.lower()] = chain_name

    return accounts, chains, aliases


# ═══════════════════════════════════════════════════════════════════════════
# Global state — loaded once at startup, reloadable via SIGHUP
# ═══════════════════════════════════════════════════════════════════════════

_accounts: dict[str, AccountSlot] = {}
_chains: dict[str, FallbackChain] = {}
_aliases: dict[str, str] = {}


def reload_config(path: str | None = None) -> None:
    """Reload chains config from disk."""
    global _accounts, _chains, _aliases
    cfg = _load_config(path or CHAINS_CONFIG_PATH)
    _accounts, _chains, _aliases = _build_registry(cfg)
    _load_health_from_db()


def init_registry() -> None:
    """Call once at startup."""
    reload_config()


# ═══════════════════════════════════════════════════════════════════════════
# Health + budget tracking
# ═══════════════════════════════════════════════════════════════════════════

async def _get_db_pool():
    """Lazy import to avoid circular dep."""
    import db
    return await db.get_pool()


async def persist_health(slot: AccountSlot) -> None:
    """Write health state to ops-db."""
    try:
        pool = await _get_db_pool()
        await pool.execute(
            """INSERT INTO model_account_health (account_id, healthy, last_error, last_check)
               VALUES ($1, $2, $3, now())
               ON CONFLICT (account_id) DO UPDATE SET
                 healthy = EXCLUDED.healthy,
                 last_error = EXCLUDED.last_error,
                 last_check = now()""",
            slot.account_id, slot.healthy, slot.last_error,
        )
    except Exception:
        pass  # DB not available — in-memory only


async def persist_usage(slot: AccountSlot, cost_usd: float, tokens: int = 0) -> None:
    """Accumulate daily usage in ops-db."""
    try:
        pool = await _get_db_pool()
        await pool.execute(
            """INSERT INTO model_account_usage (account_id, usage_date, cost_usd, tokens)
               VALUES ($1, CURRENT_DATE, $2, $3)
               ON CONFLICT (account_id, usage_date) DO UPDATE SET
                 cost_usd = model_account_usage.cost_usd + $2,
                 tokens = model_account_usage.tokens + $3""",
            slot.account_id, cost_usd, tokens,
        )
    except Exception:
        pass


def _load_health_from_db() -> None:
    """Sync loader for startup — best effort."""
    try:
        import psycopg
        with psycopg.connect(config.OPS_DB_URL) as conn:
            with conn.cursor() as cur:
                # Load health
                cur.execute("SELECT account_id, healthy, last_error FROM model_account_health")
                for row in cur.fetchall():
                    aid, healthy, err = row
                    if aid in _accounts:
                        _accounts[aid].healthy = healthy
                        _accounts[aid].last_error = err or ""

                # Load today's usage
                cur.execute(
                    "SELECT account_id, cost_usd FROM model_account_usage WHERE usage_date = CURRENT_DATE"
                )
                for row in cur.fetchall():
                    aid, cost = row
                    if aid in _accounts:
                        _accounts[aid].used_usd = float(cost or 0)
    except Exception:
        pass  # DB not available yet — starts fresh


def report_model_failure(account_id: str, error: str) -> None:
    """Mark an account unhealthy (volatile — persisted async)."""
    slot = _accounts.get(account_id)
    if slot:
        slot.healthy = False
        slot.last_error = error[:500]
        slot.last_check = time.time()
        # Fire-and-forget persist
        import asyncio
        try:
            asyncio.create_task(persist_health(slot))
        except RuntimeError:
            pass


def report_model_success(account_id: str, cost_usd: float = 0.0, tokens: int = 0) -> None:
    """Mark an account healthy and accumulate usage."""
    slot = _accounts.get(account_id)
    if slot:
        slot.healthy = True
        slot.last_error = ""
        slot.last_check = time.time()
        slot.used_usd += cost_usd
        import asyncio
        try:
            asyncio.create_task(persist_health(slot))
            if cost_usd > 0:
                asyncio.create_task(persist_usage(slot, cost_usd, tokens))
        except RuntimeError:
            pass


# ═══════════════════════════════════════════════════════════════════════════
# Resolution
# ═══════════════════════════════════════════════════════════════════════════

def resolve_model(hint: str | None = None) -> ResolvedModel:
    """Resolve a model hint to a concrete account + env overrides.

    Walks the chain until it finds a healthy, under-budget slot.
    Returns the first available — caller handles retry if task fails.
    """
    chain_name = "sonnet"  # default chain

    if hint:
        h = hint.lower()
        # Check aliases first
        if h in _aliases:
            chain_name = _aliases[h]
        else:
            # Try to match chain name directly
            if h in _chains:
                chain_name = h

    chain = _chains.get(chain_name)
    if not chain:
        # Fallback to any available chain
        for c in _chains.values():
            chain = c
            break

    if not chain or not chain.slots:
        # Emergency: just use the default model with no overrides
        return ResolvedModel(
            model=config.DEFAULT_MODEL,
            account_id="unknown",
            provider="anthropic",
            tier="sub",
            was_failover=False,
            failover_from=None,
            env_overrides={"ANTHROPIC_API_KEY": None},
        )

    slot = chain.next_available()
    if not slot:
        # All unhealthy/over-budget — force first slot anyway
        slot = chain.slots[0]

    return ResolvedModel(
        model=slot.model,
        account_id=slot.account_id,
        provider=slot.provider,
        tier=slot.tier,
        was_failover=False,
        failover_from=None,
        env_overrides=slot.env_overrides,
    )


def resolve_chain(hint: str | None = None) -> FallbackChain | None:
    """Get the full chain for a hint (used by retry logic)."""
    chain_name = "sonnet"
    if hint:
        h = hint.lower()
        if h in _aliases:
            chain_name = _aliases[h]
        elif h in _chains:
            chain_name = h
    return _chains.get(chain_name)


# ═══════════════════════════════════════════════════════════════════════════
# Status / probe tools
# ═══════════════════════════════════════════════════════════════════════════

def get_model_status() -> list[dict]:
    """Return status of all accounts across all chains."""
    results = []
    seen: set[str] = set()
    for slot in _accounts.values():
        if slot.account_id in seen:
            continue
        seen.add(slot.account_id)
        results.append({
            "account_id": slot.account_id,
            "provider": slot.provider,
            "tier": slot.tier,
            "model": slot.model,
            "healthy": slot.healthy,
            "over_budget": slot.over_budget,
            "available": slot.available,
            "used_usd": round(slot.used_usd, 4),
            "daily_budget_usd": slot.daily_budget_usd,
            "budget_remaining_usd": round(max(0, slot.daily_budget_usd - slot.used_usd), 4),
            "last_error": slot.last_error,
            "base_url": slot.base_url,
        })
    return results


def get_chain_status() -> list[dict]:
    """Return chain definitions with slot availability."""
    results = []
    for name, chain in _chains.items():
        results.append({
            "chain": name,
            "slots": [
                {
                    "account_id": s.account_id,
                    "model": s.model,
                    "provider": s.provider,
                    "tier": s.tier,
                    "available": s.available,
                }
                for s in chain.slots
            ],
        })
    return results


async def probe_models() -> list[dict]:
    """Probe each account for reachability."""
    import asyncio

    results = []

    async def _probe_http(slot: AccountSlot) -> dict:
        url = slot.base_url
        if not url:
            # OAuth tier — check claude binary
            import shutil
            if shutil.which("claude"):
                slot.healthy = True
                slot.last_error = ""
                await persist_health(slot)
                return {"account_id": slot.account_id, "reachable": True, "method": "binary"}
            else:
                slot.healthy = False
                slot.last_error = "claude binary not found"
                await persist_health(slot)
                return {"account_id": slot.account_id, "reachable": False, "error": "no binary"}

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(url)
                slot.healthy = True
                slot.last_error = ""
                slot.last_check = time.time()
                await persist_health(slot)
                return {"account_id": slot.account_id, "reachable": True, "status": resp.status_code}
        except Exception as exc:
            slot.healthy = False
            slot.last_error = str(exc)[:200]
            slot.last_check = time.time()
            await persist_health(slot)
            return {"account_id": slot.account_id, "reachable": False, "error": str(exc)[:200]}

    tasks = [_probe_http(s) for s in _accounts.values()]
    if tasks:
        results = await asyncio.gather(*tasks)
    return list(results)
