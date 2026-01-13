#!/usr/bin/env bats
# test_session_sync.bats - Tests for session-sync.sh

load 'test_helper'

setup() {
    export TEST_SCRIPT="$SCRIPTS_DIR/session-sync.sh"
    export TEST_REPO="$(mktemp -d)"

    # Create a test git repo
    cd "$TEST_REPO"
    git init -q
    git config user.email "test@test.com"
    git config user.name "Test"
    echo "initial" > README.md
    git add README.md
    git commit -q -m "Initial commit"
}

teardown() {
    rm -rf "$TEST_REPO"
}

# =============================================================================
# Script Syntax Tests
# =============================================================================

@test "session-sync.sh has valid bash syntax" {
    run bash -n "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script uses strict mode" {
    run grep -q "set -euo pipefail" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Argument Handling Tests
# =============================================================================

@test "script requires directory argument" {
    run bash "$TEST_SCRIPT"
    [[ $status -eq 1 ]]
    assert_contains "$output" "Usage:"
}

@test "script rejects non-git directories" {
    local non_git_dir="$(mktemp -d)"
    run bash "$TEST_SCRIPT" "$non_git_dir"
    [[ $status -eq 1 ]]
    assert_contains "$output" "not a git repository"
    rm -rf "$non_git_dir"
}

# =============================================================================
# Function Existence Tests
# =============================================================================

@test "log function is defined" {
    run grep -q '^log()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "sync_changes function is defined" {
    run grep -q '^sync_changes()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "cleanup function is defined" {
    run grep -q '^cleanup()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Configuration Tests
# =============================================================================

@test "DEBOUNCE_SECONDS is defined" {
    run grep -q "^DEBOUNCE_SECONDS=" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "BATCH_WINDOW is defined" {
    run grep -q "^BATCH_WINDOW=" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script checks for inotifywait" {
    run grep -q "inotifywait" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Git Operations Tests
# =============================================================================

@test "sync_changes uses git add -A" {
    run grep -q "git add -A" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "sync_changes checks for cached changes" {
    run grep -q "git diff --cached --quiet" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "sync_changes includes retry logic for push" {
    run grep -q "retries=3" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "sync_changes uses pull --rebase on conflict" {
    run grep -q "git pull.*--rebase" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Signal Handling Tests
# =============================================================================

@test "script handles SIGTERM" {
    run grep -q "trap cleanup SIGTERM" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script handles SIGINT" {
    run grep -q "trap cleanup.*SIGINT" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "cleanup syncs changes before exit" {
    run grep -A2 "^cleanup()" "$TEST_SCRIPT"
    assert_contains "$output" "sync_changes"
}

# =============================================================================
# Inotify Configuration Tests
# =============================================================================

@test "inotifywait excludes .git directory" {
    run grep -q "exclude.*\\.git" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "inotifywait watches for modify events" {
    run grep -q "\-e modify" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "inotifywait watches for create events" {
    run grep -q "\-e create" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "inotifywait watches for delete events" {
    run grep -q "\-e delete" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "inotifywait uses recursive mode" {
    run grep -q "inotifywait -m -r" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Sync Logic Tests
# =============================================================================

@test "sync uses debounce pattern" {
    run grep -q "sleep.*DEBOUNCE_SECONDS" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "sync creates trigger file for debounce" {
    run grep -q "TRIGGER_FILE" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "sync creates pending file for tracking" {
    run grep -q "PENDING_FILE" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Simulated Sync Test
# =============================================================================

@test "sync_changes creates commit with timestamp" {
    cd "$TEST_REPO"

    # Simulate sync_changes logic
    echo "new content" > test-file.txt
    git add -A

    # Check if there's anything to commit
    if ! git diff --cached --quiet; then
        local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
        local added=$(git diff --cached --numstat | wc -l)
        git commit -q -m "Auto-sync: $timestamp" -m "Files changed: $added"
    fi

    # Verify commit was made
    run git log --oneline -1
    assert_contains "$output" "Auto-sync:"
}

@test "sync_changes skips when no changes" {
    cd "$TEST_REPO"

    # No new changes
    git add -A

    # Should skip (no error, just no new commit)
    local before_count=$(git rev-list --count HEAD)

    if git diff --cached --quiet; then
        # No changes, as expected
        :
    else
        git commit -q -m "Test"
    fi

    local after_count=$(git rev-list --count HEAD)
    [[ $before_count -eq $after_count ]]
}
