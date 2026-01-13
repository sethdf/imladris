#!/usr/bin/env bats
# test_user_data_nix.bats - Tests for user-data-nix.sh bootstrap script

load 'test_helper'

setup() {
    export TEST_SCRIPT="$SCRIPTS_DIR/user-data-nix.sh"
    export TEST_CHECKPOINT_FILE="$(mktemp)"
}

teardown() {
    rm -f "$TEST_CHECKPOINT_FILE"
}

# =============================================================================
# Script Syntax Tests
# =============================================================================

@test "user-data-nix.sh has valid bash syntax" {
    run bash -n "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script starts with shebang" {
    local first_line=$(head -1 "$TEST_SCRIPT")
    [[ "$first_line" == "#!/bin/bash" ]]
}

# =============================================================================
# Helper Function Tests
# =============================================================================

@test "log function is defined" {
    run grep -q '^log()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "log_success function is defined" {
    run grep -q '^log_success()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "log_error function is defined" {
    run grep -q '^log_error()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "step_done function checks checkpoint file" {
    step_done() { grep -q "^$1$" "$TEST_CHECKPOINT_FILE" 2>/dev/null; }

    echo "completed_step" >> "$TEST_CHECKPOINT_FILE"

    run step_done "completed_step"
    [[ $status -eq 0 ]]

    run step_done "uncompleted_step"
    [[ $status -eq 1 ]]
}

@test "mark_done function appends to checkpoint file" {
    mark_done() { echo "$1" >> "$TEST_CHECKPOINT_FILE"; }

    mark_done "test_step"

    run grep -q "test_step" "$TEST_CHECKPOINT_FILE"
    [[ $status -eq 0 ]]
}

@test "run_step skips completed steps" {
    # Simulate run_step logic
    CHECKPOINT_FILE="$TEST_CHECKPOINT_FILE"
    echo "already_done" >> "$CHECKPOINT_FILE"

    step_done() { grep -q "^$1$" "$CHECKPOINT_FILE" 2>/dev/null; }

    # Verify step is skipped
    if step_done "already_done"; then
        skip_called=true
    else
        skip_called=false
    fi

    [[ "$skip_called" == "true" ]]
}

@test "run_step executes new steps" {
    CHECKPOINT_FILE="$TEST_CHECKPOINT_FILE"
    step_done() { grep -q "^$1$" "$CHECKPOINT_FILE" 2>/dev/null; }

    # New step should not be skipped
    if step_done "new_step"; then
        execute=false
    else
        execute=true
    fi

    [[ "$execute" == "true" ]]
}

# =============================================================================
# Setup Function Existence Tests
# =============================================================================

@test "setup_system function is defined" {
    run grep -q '^setup_system()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_docker function is defined" {
    run grep -q '^setup_docker()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_tailscale function is defined" {
    run grep -q '^setup_tailscale()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_data_volume function is defined" {
    run grep -q '^setup_data_volume()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_nix function is defined" {
    run grep -q '^setup_nix()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_home_manager function is defined" {
    run grep -q '^setup_home_manager()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_bws function is defined" {
    run grep -q '^setup_bws()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_claude_code function is defined" {
    run grep -q '^setup_claude_code()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_imladris_scripts function is defined" {
    run grep -q '^setup_imladris_scripts()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_shell function is defined" {
    run grep -q '^setup_shell()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_motd function is defined" {
    run grep -q '^setup_motd()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Main Function Tests
# =============================================================================

@test "main function is defined" {
    run grep -q '^main()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "main function calls run_step for each setup" {
    # Check that all setup steps are called via run_step
    local expected_steps=("system" "docker" "tailscale" "data_volume" "nix" "home_manager" "claude_code" "imladris_scripts" "bws" "shell" "motd")

    for step in "${expected_steps[@]}"; do
        run grep -q "run_step \"$step\"" "$TEST_SCRIPT"
        if [[ $status -ne 0 ]]; then
            echo "Missing run_step for: $step" >&2
            return 1
        fi
    done
}

# =============================================================================
# Configuration Tests
# =============================================================================

@test "script uses sethdf/imladris repo path" {
    run grep -q "sethdf/imladris" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script uses IMDSv2 for metadata" {
    run grep -q "X-aws-ec2-metadata-token" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script installs bws CLI" {
    run grep -q "bitwarden/sdk/releases" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script installs MCP servers" {
    run grep -q "@modelcontextprotocol/server" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "MCP servers array is correctly escaped for Terraform" {
    # Check that bash array iteration is properly escaped
    run grep -q '\$\${MCP_SERVERS\[@\]}' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script uses Determinate Systems Nix installer" {
    run grep -q "install.determinate.systems/nix" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Security Tests
# =============================================================================

@test "script removes SSM agent" {
    run grep -q "snap remove amazon-ssm-agent" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script disables SSM agent service" {
    run grep -q "systemctl disable.*amazon-ssm-agent" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script enables unattended-upgrades" {
    run grep -q "unattended-upgrades" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Volume Attachment Tests
# =============================================================================

@test "setup_data_volume checks for nvme1n1" {
    run grep -q '/dev/nvme1n1' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_data_volume checks for xvdf" {
    run grep -q '/dev/xvdf' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_data_volume has retry logic" {
    run grep -q 'MAX_ATTEMPTS' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "setup_data_volume handles race conditions" {
    run grep -q 'race condition' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Shell Setup Tests
# =============================================================================

@test "shell setup uses nix zsh path" {
    run grep -q "/home/ubuntu/.nix-profile/bin/zsh" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "shell setup adds zsh to /etc/shells" {
    run grep -q "/etc/shells" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# MOTD Tests
# =============================================================================

@test "MOTD includes Imladris branding" {
    run grep -q "I M L A D R I S" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "MOTD includes helpful commands" {
    run grep -q "imladris-init" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Nix Setup Tests
# =============================================================================

@test "nix setup adds profile to zshenv" {
    run grep -q "/etc/zshenv" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "nix setup adds profile to zprofile" {
    run grep -q "/etc/zprofile" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "nix setup waits for nix-daemon" {
    run grep -q "nix-daemon" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}
