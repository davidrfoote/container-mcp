#!/bin/bash
set -e

echo "Running npm security audit..."
npm audit --audit-level=high
echo "Security scan complete."
