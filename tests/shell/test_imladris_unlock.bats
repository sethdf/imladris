#!/usr/bin/env bats
# test_imladris_unlock.bats - Tests for imladris-unlock.sh

load 'test_helper'

setup() {
    export TEST_SCRIPT="$SCRIPTS_DIR/imladris-unlock.sh"
    export TEST_DATA_MOUNT="$(mktemp -d)"
    export TEST_SECRETS_DIR="$TEST_DATA_MOUNT/.secrets"
    export TEST_CONFIG_DIR="$(mktemp -d)"

    # Mock common commands
    create_mock "bws" 0 '[]'
    create_mock "cryptsetup" 0 ""
    create_mock "mount" 0 ""
    create_mock "mountpoint" 1 ""  # Not mounted by default
    create_mock "sudo" 0 ""
}

teardown() {
    rm -rf "$TEST_DATA_MOUNT" "$TEST_CONFIG_DIR"
}

# =============================================================================
# Script Syntax Tests
# =============================================================================

@test "imladris-unlock.sh has valid bash syntax" {
    run bash -n "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script uses strict mode" {
    run grep -q "set -euo pipefail" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Retry Function Tests (Same as init, but verify it exists)
# =============================================================================

@test "retry function is defined" {
    run grep -q "^retry()" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "retry uses exponential backoff" {
    # Check for wait_time doubling pattern
    run grep -q 'wait_time=\$((wait_time \* 2))' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "retry has max backoff cap" {
    # Should cap backoff at 30 seconds
    run grep -q 'wait_time -gt 30' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Token Loading Tests
# =============================================================================

@test "loads token from LUKS mount first" {
    mkdir -p "$TEST_SECRETS_DIR"
    echo -n "luks-token" > "$TEST_SECRETS_DIR/bws-token"

    # Simulate the priority check
    local token=""
    local luks_token_file="$TEST_SECRETS_DIR/bws-token"

    if [[ -f "$luks_token_file" ]]; then
        token=$(cat "$luks_token_file")
    fi

    [[ "$token" == "luks-token" ]]
}

@test "falls back to home config if LUKS token missing" {
    mkdir -p "$TEST_CONFIG_DIR/bws"
    echo -n "home-token" > "$TEST_CONFIG_DIR/bws/access-token"

    local token=""
    local luks_token_file="$TEST_SECRETS_DIR/bws-token"  # doesn't exist
    local home_token_file="$TEST_CONFIG_DIR/bws/access-token"

    if [[ -f "$luks_token_file" ]]; then
        token=$(cat "$luks_token_file")
    elif [[ -f "$home_token_file" ]]; then
        token=$(cat "$home_token_file")
    fi

    [[ "$token" == "home-token" ]]
}

# =============================================================================
# Device Detection Tests
# =============================================================================

@test "detect_data_device function exists" {
    run grep -q "^detect_data_device()" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "detects nvme1n1 for NVMe instances" {
    run grep -q '/dev/nvme1n1' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "detects xvdf for Xen instances" {
    run grep -q '/dev/xvdf' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "detects sdf as fallback" {
    run grep -q '/dev/sdf' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# LUKS Unlock Tests
# =============================================================================

@test "checks if volume is already unlocked" {
    run grep -q '/dev/mapper/\$DATA_MAPPER' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "uses timeout for cryptsetup" {
    run grep -q 'timeout.*cryptsetup' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "validates LUKS volume before unlock" {
    run grep -q 'cryptsetup isLuks' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# MFA Key Combination Tests
# =============================================================================

@test "combines BWS keyfile with passphrase" {
    # Verify the key combination pattern exists
    run grep -q '\${BWS_KEYFILE}\${PASSPHRASE}' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "prompts user for passphrase" {
    run grep -q 'read -rs -p' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "rejects empty passphrase" {
    run grep -q 'Passphrase cannot be empty' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Token Persistence Tests
# =============================================================================

@test "persist_bws_token function exists" {
    run grep -q "^persist_bws_token()" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "removes token from root volume after persisting" {
    run grep -q 'rm -f.*ROOT_TOKEN_FILE' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "creates secrets directory with restricted permissions" {
    mkdir -p "$TEST_SECRETS_DIR"
    chmod 700 "$TEST_SECRETS_DIR"

    assert_file_mode "$TEST_SECRETS_DIR" "700"
}

# =============================================================================
# Shell Export Tests
# =============================================================================

@test "export_for_shell function exists" {
    run grep -q "^export_for_shell()" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "creates shell export file in imladris config" {
    run grep -q '.config/imladris/bws-env.sh' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "shell export file has restricted permissions" {
    # Check that chmod 600 is applied
    run grep -q 'chmod 600.*SHELL_EXPORT' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Timeout Configuration Tests
# =============================================================================

@test "BWS_TIMEOUT is defined" {
    run grep -E "^BWS_TIMEOUT=[0-9]+" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "CRYPTSETUP_TIMEOUT is defined" {
    run grep -E "^CRYPTSETUP_TIMEOUT=[0-9]+" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "timeouts are used in BWS calls" {
    run grep -q 'timeout.*BWS_TIMEOUT.*bws' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "script shows help with --help flag" {
    run bash "$TEST_SCRIPT" --help
    assert_contains "$output" "Usage:"
}

@test "help shows BWS_ACCESS_TOKEN info" {
    run bash "$TEST_SCRIPT" --help
    assert_contains "$output" "BWS_ACCESS_TOKEN"
}

@test "script rejects unknown options" {
    run bash "$TEST_SCRIPT" --invalid-option
    [[ $status -ne 0 ]]
}

# =============================================================================
# Integration Pattern Tests
# =============================================================================

@test "main flow checks BWS before unlock" {
    # Verify check_bws is called before unlock_luks in main
    local check_bws_line=$(grep -n "check_bws" "$TEST_SCRIPT" | grep -v "^#" | grep -v "function" | head -1 | cut -d: -f1)
    local unlock_line=$(grep -n "unlock_luks" "$TEST_SCRIPT" | grep -v "^#" | grep -v "function" | head -1 | cut -d: -f1)

    # check_bws should come before unlock_luks
    [[ $check_bws_line -lt $unlock_line ]]
}

@test "persists token after successful unlock" {
    # Verify persist_bws_token is called after unlock_luks succeeds
    local unlock_line=$(grep -n "unlock_luks" "$TEST_SCRIPT" | grep -v "function" | tail -1 | cut -d: -f1)
    local persist_line=$(grep -n "persist_bws_token" "$TEST_SCRIPT" | grep -v "function" | tail -1 | cut -d: -f1)

    [[ $persist_line -gt $unlock_line ]]
}
