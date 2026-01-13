#!/usr/bin/env bash
# run_tests.sh - Run bats shell tests
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check for bats
if ! command -v bats &>/dev/null; then
    echo "bats-core is not installed."
    echo ""
    echo "Install with:"
    echo "  # Ubuntu/Debian"
    echo "  sudo apt-get install bats"
    echo ""
    echo "  # macOS"
    echo "  brew install bats-core"
    echo ""
    echo "  # Nix"
    echo "  nix-env -iA nixpkgs.bats"
    echo ""
    exit 1
fi

# Run all tests or specific test file
if [[ $# -gt 0 ]]; then
    bats "$@"
else
    bats "$SCRIPT_DIR"/*.bats
fi
