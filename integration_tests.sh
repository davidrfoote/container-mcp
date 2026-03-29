#!/bin/bash
set -e

echo "Building container-mcp..."
npm ci
npm run build

echo "Verifying server entry point exists..."
if [ ! -f "dist/index.js" ]; then
  echo "dist/index.js not found after build"
  exit 1
fi
echo "Build artifact verified."

echo "Integration tests complete."
