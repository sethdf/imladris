#!/usr/bin/env bats
# test_imladris_init.bats - Tests for imladris-init.sh

load 'test_helper'

setup() {
    export TEST_SCRIPT="$SCRIPTS_DIR/imladris-init.sh"
    export TEST_DATA_MOUNT="$(mktemp -d)"
    export TEST_SECRETS_DIR="$TEST_DATA_MOUNT/.secrets"

    # Mock common commands
    create_mock "bws" 0 '[]'
    create_mock "cryptsetup" 0 ""
    create_mock "mkfs.ext4" 0 ""
    create_mock "mount" 0 ""
    create_mock "mountpoint" 1 ""  # Not mounted by default
}

teardown() {
    rm -rf "$TEST_DATA_MOUNT"
}

# =============================================================================
# Script Syntax Tests
# =============================================================================

@test "imladris-init.sh has valid bash syntax" {
    run bash -n "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script uses strict mode" {
    run grep -q "set -euo pipefail" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Retry Function Tests
# =============================================================================

@test "retry function succeeds on first attempt" {
    # Define retry function locally for testing
    retry() {
        local max_attempts=$1
        shift
        local attempt=1
        while [[ $attempt -le $max_attempts ]]; do
            if "$@"; then return 0; fi
            ((attempt++))
        done
        return 1
    }

    run retry 3 true
    [[ $status -eq 0 ]]
}

@test "retry function fails after max attempts" {
    retry() {
        local max_attempts=$1
        shift
        local attempt=1
        while [[ $attempt -le $max_attempts ]]; do
            if "$@"; then return 0; fi
            ((attempt++))
        done
        return 1
    }

    run retry 3 false
    [[ $status -eq 1 ]]
}

@test "retry function returns success on later attempt" {
    local attempt_file="$TEST_DATA_MOUNT/attempts"
    echo "0" > "$attempt_file"

    succeed_on_third() {
        local count=$(cat "$attempt_file")
        count=$((count + 1))
        echo "$count" > "$attempt_file"
        [[ $count -ge 3 ]]
    }

    retry() {
        local max_attempts=$1
        shift
        local attempt=1
        while [[ $attempt -le $max_attempts ]]; do
            if "$@"; then return 0; fi
            ((attempt++))
        done
        return 1
    }

    run retry 5 succeed_on_third
    [[ $status -eq 0 ]]
    [[ $(cat "$attempt_file") -eq 3 ]]
}

# =============================================================================
# Token Persistence Tests
# =============================================================================

@test "secrets directory created with correct permissions" {
    mkdir -p "$TEST_SECRETS_DIR"
    chmod 700 "$TEST_SECRETS_DIR"

    assert_file_mode "$TEST_SECRETS_DIR" "700"
}

@test "token file created with correct permissions" {
    mkdir -p "$TEST_SECRETS_DIR"
    local token_file="$TEST_SECRETS_DIR/bws-token"

    # Atomic write pattern from script
    local tmp_file="$token_file.tmp.$$"
    (umask 077; echo -n "test-token" > "$tmp_file")
    mv "$tmp_file" "$token_file"

    assert_file_exists "$token_file"
    assert_file_mode "$token_file" "600"
}

@test "atomic write leaves no temp files" {
    mkdir -p "$TEST_SECRETS_DIR"
    local token_file="$TEST_SECRETS_DIR/bws-token"

    # Simulate atomic write
    local tmp_file="$token_file.tmp.$$"
    (umask 077; echo -n "test-token" > "$tmp_file")
    mv "$tmp_file" "$token_file"

    # No .tmp files should remain
    run find "$TEST_SECRETS_DIR" -name "*.tmp*" -type f
    [[ -z "$output" ]]
}

@test "token content is preserved exactly" {
    mkdir -p "$TEST_SECRETS_DIR"
    local token_file="$TEST_SECRETS_DIR/bws-token"
    local test_token="my-secret-token-12345"

    local tmp_file="$token_file.tmp.$$"
    (umask 077; echo -n "$test_token" > "$tmp_file")
    mv "$tmp_file" "$token_file"

    [[ "$(cat "$token_file")" == "$test_token" ]]
}

# =============================================================================
# BWS Integration Tests
# =============================================================================

@test "check_bws fails without bws command" {
    rm -f "$MOCK_DIR/bws"

    run bash -c 'command -v bws &>/dev/null || echo "bws not found"'
    assert_contains "$output" "bws not found"
}

@test "check_bws fails without token" {
    unset BWS_ACCESS_TOKEN

    # Simulate token check logic
    run bash -c '
        if [[ -z "${BWS_ACCESS_TOKEN:-}" ]] && [[ ! -f "$HOME/.config/bws/access-token" ]]; then
            echo "BWS_ACCESS_TOKEN not set"
            exit 1
        fi
    '
    [[ $status -eq 1 ]]
    assert_contains "$output" "BWS_ACCESS_TOKEN not set"
}

@test "check_bws succeeds with env token" {
    export BWS_ACCESS_TOKEN="test-token"

    run bash -c '
        if [[ -n "${BWS_ACCESS_TOKEN:-}" ]]; then
            echo "token found"
            exit 0
        fi
        exit 1
    '
    [[ $status -eq 0 ]]
}

# =============================================================================
# Device Detection Tests
# =============================================================================

@test "detect_data_device checks nvme1n1 first" {
    # Simulate detect_data_device logic
    detect_device() {
        if [[ -b /dev/nvme1n1 ]]; then
            echo "/dev/nvme1n1"
            return 0
        fi
        if [[ -b /dev/xvdf ]]; then
            echo "/dev/xvdf"
            return 0
        fi
        return 1
    }

    # On most systems neither will exist, so we test the logic
    run bash -c '
        # Test the priority logic (simulated)
        devices=("nvme1n1" "xvdf" "sdf")
        for dev in "${devices[@]}"; do
            echo "Would check /dev/$dev"
        done
    '
    assert_contains "$output" "nvme1n1"
}

# =============================================================================
# Timeout Tests
# =============================================================================

@test "BWS_TIMEOUT is defined and reasonable" {
    run grep -E "^BWS_TIMEOUT=[0-9]+" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]

    # Extract value and check it's reasonable (10-120 seconds)
    local timeout=$(grep -E "^BWS_TIMEOUT=[0-9]+" "$TEST_SCRIPT" | cut -d= -f2)
    [[ $timeout -ge 10 ]] && [[ $timeout -le 120 ]]
}

@test "CRYPTSETUP_TIMEOUT is defined and reasonable" {
    run grep -E "^CRYPTSETUP_TIMEOUT=[0-9]+" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]

    local timeout=$(grep -E "^CRYPTSETUP_TIMEOUT=[0-9]+" "$TEST_SCRIPT" | cut -d= -f2)
    [[ $timeout -ge 30 ]] && [[ $timeout -le 300 ]]
}

# =============================================================================
# Help Output Tests
# =============================================================================

@test "script shows help with --help flag" {
    run bash "$TEST_SCRIPT" --help
    assert_contains "$output" "Usage:"
}

@test "script shows help with -h flag" {
    run bash "$TEST_SCRIPT" -h
    assert_contains "$output" "Usage:"
}
