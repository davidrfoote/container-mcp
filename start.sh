#!/bin/bash
export OPS_DB_URL="postgresql://ops:Pi5cSfj9ASfNoBBklkGUR65uBazG6iNn@172.17.0.1:5434/ops"
export REDIS_HOST="redis-relay-devenv"
export REDIS_PORT="6379"
export OPENCLAW_GATEWAY_TOKEN="fae882977af961aa47dda858d942b4f39317c73ae1e1bb59"
# Deploy-agent: host-side HTTP API for docker operations (avoids docker CLI issues in containers)
export DEPLOY_AGENT_URL="http://172.17.0.1:18790"
export DEPLOY_AGENT_TOKEN="547e0a7b46aca7d2cdd6f45ab6b06914796142305303b0b7607354253602f49b"
cd /home/david/container-mcp
exec node dist/index.js
