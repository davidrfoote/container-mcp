#!/bin/bash
set -e

echo "Installing dependencies..."
npm ci

echo "Compiling TypeScript..."
npm run build
echo "Build complete."
