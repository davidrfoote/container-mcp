#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/.env" ]; then
  set -a
  source "${SCRIPT_DIR}/.env"
  set +a
fi
cd "${SCRIPT_DIR}"
export CHAINS_CONFIG_PATH="${SCRIPT_DIR}/chains.yaml"
exec python3 main.py
