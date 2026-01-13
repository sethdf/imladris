#!/bin/bash
# Run shell script tests using bats
set -euo pipefail

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    Shell Script Tests                           ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

cd /project

# Run shellcheck first
echo "Running shellcheck..."
SCRIPTS=(
    scripts/imladris-init.sh
    scripts/imladris-unlock.sh
    scripts/imladris-check.sh
    scripts/imladris-restore.sh
    scripts/session-sync.sh
    scripts/auth-keeper.sh
    scripts/bws-init.sh
)

shellcheck_failed=0
for script in "${SCRIPTS[@]}"; do
    if [[ -f "$script" ]]; then
        echo -n "  $script... "
        if shellcheck -x "$script" 2>/dev/null; then
            echo "OK"
        else
            echo "WARNINGS"
            ((shellcheck_failed++)) || true
        fi
    fi
done
echo ""

# Run bats tests
echo "Running bats tests..."
echo ""

# Find all .bats files
bats_files=$(find tests/shell -name "*.bats" -type f 2>/dev/null || true)

if [[ -z "$bats_files" ]]; then
    echo "No bats test files found"
    exit 0
fi

# Run bats with tap output
bats --tap tests/shell/*.bats

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "Shell tests complete"
if [[ $shellcheck_failed -gt 0 ]]; then
    echo "Note: $shellcheck_failed scripts had shellcheck warnings"
fi
