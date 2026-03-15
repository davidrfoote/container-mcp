#!/bin/bash
# Load environment variables from .env file if present
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/.env" ]; then
  set -a
  # shellcheck source=.env
  source "${SCRIPT_DIR}/.env"
  set +a
fi
cd "${SCRIPT_DIR}"
exec node dist/index.js
