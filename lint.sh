#!/bin/bash
set -e

echo "Installing dependencies..."
npm ci

echo "Type-checking TypeScript (tsc --noEmit)..."
npx tsc --noEmit
echo "Lint complete."
