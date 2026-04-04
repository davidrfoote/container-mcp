"""
Git helpers — diff and repo state queries.
"""
from __future__ import annotations

import asyncio


async def _run(cmd: list[str], cwd: str) -> tuple[str, str, int]:
    """Run a subprocess and return (stdout, stderr, returncode)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return stdout.decode(errors="replace"), stderr.decode(errors="replace"), proc.returncode


async def get_diff(working_dir: str, diff_type: str = "working") -> str:
    """
    Get git diff output.

    diff_type:
      'working'  — unstaged changes (git diff)
      'staged'   — staged changes   (git diff --cached)
      'head'     — all changes vs HEAD (git diff HEAD)
    """
    if diff_type == "staged":
        cmd = ["git", "diff", "--cached"]
    elif diff_type == "head":
        cmd = ["git", "diff", "HEAD"]
    else:
        cmd = ["git", "diff"]

    stdout, stderr, rc = await _run(cmd, working_dir)
    if rc != 0:
        return f"git diff failed (rc={rc}): {stderr.strip()}"
    return stdout or "(no diff)"


async def get_repo_state(working_dir: str) -> dict:
    """
    Return current branch, dirty status, staged file list, and recent commits.
    """
    # Current branch
    branch_out, _, _ = await _run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], working_dir
    )
    branch = branch_out.strip()

    # Porcelain status
    status_out, _, _ = await _run(
        ["git", "status", "--porcelain"], working_dir
    )
    status_lines = [l for l in status_out.splitlines() if l.strip()]
    staged = [l[3:] for l in status_lines if l[0] not in (" ", "?")]
    unstaged = [l[3:] for l in status_lines if l[0] == " " and l[1] != " "]
    untracked = [l[3:] for l in status_lines if l[:2] == "??"]
    dirty = len(status_lines) > 0

    # Recent commits
    log_out, _, _ = await _run(
        ["git", "log", "--oneline", "-10"], working_dir
    )
    recent_commits = log_out.strip().splitlines() if log_out.strip() else []

    # Last commit hash
    hash_out, _, _ = await _run(
        ["git", "rev-parse", "HEAD"], working_dir
    )
    head_sha = hash_out.strip()

    return {
        "branch": branch,
        "head_sha": head_sha,
        "dirty": dirty,
        "staged": staged,
        "unstaged": unstaged,
        "untracked": untracked,
        "recent_commits": recent_commits,
    }
