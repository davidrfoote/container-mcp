#!/bin/bash
set -e
cd /home/david/container-mcp
git init
git config user.email "david@zennya.com"
git config user.name "David Foote"
git add -A
git commit -m "feat: container MCP server v2.0.0 (Phase 1+2)"
git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/davidrfoote/container-mcp.git"
git push -u origin main --force
echo "PUSH_DONE"
