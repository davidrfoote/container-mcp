#!/bin/bash
export OPS_DB_URL="postgresql://ops:Pi5cSfj9ASfNoBBklkGUR65uBazG6iNn@172.17.0.2:15432/ops"
export OPENCLAW_GATEWAY_TOKEN="fae882977af961aa47dda858d942b4f39317c73ae1e1bb59"
cd /home/david/container-mcp
exec node dist/index.js
