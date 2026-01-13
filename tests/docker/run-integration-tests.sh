#!/bin/bash
# Integration tests - simulate bootstrap sequence
set -euo pipefail

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                   Integration Tests                             ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

cd /project

# Test counter
tests_passed=0
tests_failed=0

run_test() {
    local name="$1"
    shift
    echo -n "  $name... "
    if "$@" >/dev/null 2>&1; then
        echo "PASS"
        ((tests_passed++))
    else
        echo "FAIL"
        ((tests_failed++))
    fi
}

# =============================================================================
# Script Syntax Tests
# =============================================================================
echo "Script Syntax:"

run_test "imladris-init.sh syntax" bash -n scripts/imladris-init.sh
run_test "imladris-unlock.sh syntax" bash -n scripts/imladris-unlock.sh
run_test "imladris-check.sh syntax" bash -n scripts/imladris-check.sh
run_test "imladris-restore.sh syntax" bash -n scripts/imladris-restore.sh
run_test "session-sync.sh syntax" bash -n scripts/session-sync.sh
run_test "auth-keeper.sh syntax" bash -n scripts/auth-keeper.sh
run_test "user-data-nix.sh syntax" bash -n scripts/user-data-nix.sh

echo ""

# =============================================================================
# BWS Mock Tests
# =============================================================================
echo "BWS Mock Integration:"

run_test "bws --version" bws --version
run_test "bws secret list" bws secret list
run_test "bws project list" bws project list

# Test that secrets contain expected keys
echo -n "  bws returns luks-keyfile... "
if bws secret list | jq -e '.[] | select(.key == "luks-keyfile")' >/dev/null; then
    echo "PASS"
    ((tests_passed++))
else
    echo "FAIL"
    ((tests_failed++))
fi

echo ""

# =============================================================================
# Skills Installation Simulation
# =============================================================================
echo "Skills Installation Simulation:"

# Create mock repo structure
TEST_HOME=$(mktemp -d)
TEST_REPOS="$TEST_HOME/repos/github.com"
mkdir -p "$TEST_REPOS/sethdf/curu-skills/TestSkill"
mkdir -p "$TEST_REPOS/anthropics/skills/skills/pdf"
echo "# Test Skill" > "$TEST_REPOS/sethdf/curu-skills/TestSkill/SKILL.md"
echo "# PDF Skill" > "$TEST_REPOS/anthropics/skills/skills/pdf/SKILL.md"

SKILLS_DST="$TEST_HOME/.claude/skills"
mkdir -p "$SKILLS_DST"

# Simulate curu skills install
echo -n "  curu skills copy... "
for skill_dir in "$TEST_REPOS/sethdf/curu-skills"/*/; do
    [[ -d "$skill_dir" ]] || continue
    name=$(basename "$skill_dir")
    [[ "$name" == .* ]] && continue
    if [[ -f "$skill_dir/SKILL.md" ]]; then
        cp -r "$skill_dir" "$SKILLS_DST/"
    fi
done
if [[ -f "$SKILLS_DST/TestSkill/SKILL.md" ]]; then
    echo "PASS"
    ((tests_passed++))
else
    echo "FAIL"
    ((tests_failed++))
fi

# Simulate anthropic skills install
echo -n "  anthropic skills copy with prefix... "
for skill_dir in "$TEST_REPOS/anthropics/skills/skills"/*/; do
    [[ -d "$skill_dir" ]] || continue
    name=$(basename "$skill_dir")
    if [[ -f "$skill_dir/SKILL.md" ]]; then
        cp -r "$skill_dir" "$SKILLS_DST/anthropic-${name}"
    fi
done
if [[ -f "$SKILLS_DST/anthropic-pdf/SKILL.md" ]] && [[ ! -d "$SKILLS_DST/pdf" ]]; then
    echo "PASS"
    ((tests_passed++))
else
    echo "FAIL"
    ((tests_failed++))
fi

# Cleanup
rm -rf "$TEST_HOME"

echo ""

# =============================================================================
# Configuration File Tests
# =============================================================================
echo "Configuration Files:"

run_test "nix/home.nix syntax" bash -c "head -1 nix/home.nix | grep -q '{'"
run_test "nix/flake.nix exists" test -f nix/flake.nix

# Check that home.nix has required repos
echo -n "  home.nix has curu-skills repo... "
if grep -q "sethdf/curu-skills" nix/home.nix; then
    echo "PASS"
    ((tests_passed++))
else
    echo "FAIL"
    ((tests_failed++))
fi

echo -n "  home.nix has anthropics/skills repo... "
if grep -q "anthropics/skills" nix/home.nix; then
    echo "PASS"
    ((tests_passed++))
else
    echo "FAIL"
    ((tests_failed++))
fi

echo -n "  home.nix has bun in PATH... "
if grep -q '\.bun/bin' nix/home.nix; then
    echo "PASS"
    ((tests_passed++))
else
    echo "FAIL"
    ((tests_failed++))
fi

echo ""

# =============================================================================
# Summary
# =============================================================================
echo "════════════════════════════════════════════════════════════════"
total=$((tests_passed + tests_failed))
echo "Results: $tests_passed/$total passed"

if [[ $tests_failed -gt 0 ]]; then
    echo "SOME TESTS FAILED"
    exit 1
else
    echo "ALL TESTS PASSED"
fi
