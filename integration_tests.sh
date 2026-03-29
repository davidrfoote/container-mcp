#!/bin/bash
set -e

TARGET_URL="${INTEGRATION_TEST_URL:-https://dev-sessions.ash.zennya.app}"
echo "Running integration tests against $TARGET_URL..."

# Health check — expect 2xx response (pass CF headers if provided)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 \
  ${CF_CLIENT_ID:+-H "CF-Access-Client-Id: ${CF_CLIENT_ID}"} \
  ${CF_CLIENT_SECRET:+-H "CF-Access-Client-Secret: ${CF_CLIENT_SECRET}"} \
  "$TARGET_URL")
if [ "$STATUS" -lt 200 ] || [ "$STATUS" -ge 400 ]; then
  echo "Health check failed: HTTP $STATUS"
  exit 1
fi
echo "Health check passed: HTTP $STATUS"

echo "Integration tests complete."
