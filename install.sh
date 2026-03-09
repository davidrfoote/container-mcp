#!/usr/bin/env bash
# Install and start container-mcp in dev-david container
set -euo pipefail
DEST="/home/david/container-mcp"
CONTAINER="${1:-dev-david}"

# Clone or update
if [ -d "$DEST/.git" ]; then
  cd "$DEST" && git pull
else
  git clone https://x-access-token:${GITHUB_TOKEN}@github.com/davidrfoote/container-mcp "$DEST"
fi

# Install and build
docker exec "$CONTAINER" bash -c "cd /home/david/container-mcp && npm install && npm run build"

# Start (kill old instance first)
docker exec "$CONTAINER" bash -c "pkill -f 'node dist/index.js' 2>/dev/null || true"
docker exec -d "$CONTAINER" bash -c "cd /home/david/container-mcp && nohup node dist/index.js > /home/david/container-mcp.log 2>&1 &"
sleep 2
curl -s http://localhost:9000/health
