#!/bin/bash
export PORT=9100
export OPS_DB_URL="postgresql://ops:Pi5cSfj9ASfNoBBklkGUR65uBazG6iNn@172.17.0.1:5434/ops"
export OPENCLAW_GATEWAY_TOKEN="fae882977af961aa47dda858b4f39317c73ae1e1bb59"
MDIR=/home/david/container-mcp
cd "$MDIR"

# Build dist if missing (e.g. after a cold container restart)
if [ ! -f "$MDIR/dist/index.js" ]; then
  echo "[run-mcp] dist/index.js missing — building..." >> /home/david/mcp-keepalive.log
  npm install && npm run build >> /home/david/mcp-keepalive.log 2>&1
fi

while true; do
  node dist/index.js >> /home/david/mcp-keepalive.log 2>&1
  echo "[run-mcp] exited, restarting in 5s..." >> /home/david/mcp-keepalive.log
  sleep 5
done
