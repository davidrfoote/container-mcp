"""
Deploy helper — triggers deploy-orchestrator via HTTP.
"""
from __future__ import annotations

import httpx

import config


async def deploy_project(
    project_id: str,
    branch: str = "main",
    session_id: str | None = None,
) -> dict:
    """
    Trigger a deployment via the deploy-orchestrator REST endpoint.

    POST {DEPLOY_ORCHESTRATOR_URL}/deploy
    Bearer token from ORCHESTRATOR_TOKEN.

    Returns the JSON response from the orchestrator, or an error dict.
    """
    url = f"{config.DEPLOY_ORCHESTRATOR_URL}/deploy"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if config.ORCHESTRATOR_TOKEN:
        headers["Authorization"] = f"Bearer {config.ORCHESTRATOR_TOKEN}"

    payload: dict = {"project_id": project_id, "branch": branch}
    if session_id:
        payload["session_id"] = session_id

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            return {"ok": True, "status_code": resp.status_code, "data": resp.json()}
    except httpx.HTTPStatusError as exc:
        return {
            "ok": False,
            "status_code": exc.response.status_code,
            "error": exc.response.text,
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
