# AGENTS.md — container-mcp Dev Guide

This file contains mandatory instructions for all AI agents (dev-lead, coding agents, etc.) working in this repo.

---

## MANDATORY COMPLETION VERIFICATION (before posting any completion/checkpoint)

NEVER post a completion or checkpoint message with a claimed commit SHA without first running this check:

1. `cd /home/openclaw/apps/<repo> && git pull && git log --oneline | head -5`
2. Confirm your claimed commit SHA appears in the output
3. If the SHA is NOT found: do NOT post completion. Post an error message instead and investigate.
4. Only after the SHA is confirmed in `/home/openclaw/apps/<repo>` git log may you post completion.

NOTE: Your workspace is `/home/david/<repo>`. The production repo is `/home/openclaw/apps/<repo>`. These are different. Always verify against `/home/openclaw/apps/<repo>`.
