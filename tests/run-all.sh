#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Hook Tests ==="
bun test "$SCRIPT_DIR/hooks/" --timeout 30000

echo ""
echo "=== Windmill Script Tests ==="
bun test "$SCRIPT_DIR/windmill/" --timeout 30000

echo ""
echo "=== CLI Tests ==="
bun test "$SCRIPT_DIR/cli/" --timeout 30000

echo ""
echo "=== Pre-Deploy Validation ==="
bash "$SCRIPT_DIR/validate-deploy.sh"

echo ""
echo "=== All Tests Complete ==="
