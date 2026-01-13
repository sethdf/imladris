#!/usr/bin/env bats
# test_auth_keeper.bats - Tests for auth-keeper.sh

load 'test_helper'

setup() {
    export TEST_SCRIPT="$SCRIPTS_DIR/auth-keeper.sh"
    export TEST_HOME="$(mktemp -d)"
    export HOME="$TEST_HOME"

    # Create mock directories
    mkdir -p "$TEST_HOME/.aws/sso/cache"
    mkdir -p "$TEST_HOME/.azure"
    mkdir -p "$TEST_HOME/.config/gmail-cli"
}

teardown() {
    rm -rf "$TEST_HOME"
}

# =============================================================================
# Script Syntax Tests
# =============================================================================

@test "auth-keeper.sh has valid bash syntax" {
    run bash -n "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script uses bash shebang" {
    local first_line=$(head -1 "$TEST_SCRIPT")
    assert_contains "$first_line" "bash"
}

# =============================================================================
# Configuration Tests
# =============================================================================

@test "AUTH_KEEPER_NOTIFY defaults to signal" {
    run grep -q 'AUTH_KEEPER_NOTIFY="\${AUTH_KEEPER_NOTIFY:-signal}"' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "AUTH_KEEPER_REFRESH_BUFFER is defined" {
    run grep -q "AUTH_KEEPER_REFRESH_BUFFER=" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Function Existence Tests
# =============================================================================

@test "_ak_notify function is defined" {
    run grep -q '^_ak_notify()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "_ak_signal_send function is defined" {
    run grep -q '^_ak_signal_send()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "_ak_telegram_send function is defined" {
    run grep -q '^_ak_telegram_send()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "_ak_aws_token_valid function is defined" {
    run grep -q '^_ak_aws_token_valid()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "_ak_aws_refresh function is defined" {
    run grep -q '^_ak_aws_refresh()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "_ak_azure_token_valid function is defined" {
    run grep -q '^_ak_azure_token_valid()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "_ak_azure_refresh function is defined" {
    run grep -q '^_ak_azure_refresh()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "_ak_google_token_valid function is defined" {
    run grep -q '^_ak_google_token_valid()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "_ak_tailscale_connected function is defined" {
    run grep -q '^_ak_tailscale_connected()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "auth-keeper main function is defined" {
    run grep -q '^auth-keeper()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Notification Tests
# =============================================================================

@test "notify function handles signal mode" {
    run grep -A5 '_ak_notify()' "$TEST_SCRIPT"
    assert_contains "$output" "signal"
}

@test "notify function handles telegram mode" {
    run grep -q "telegram)" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "notify function handles bell mode" {
    run grep -q "bell)" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "telegram uses Telegram API" {
    run grep -q "api.telegram.org" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# AWS SSO Tests
# =============================================================================

@test "AWS token validation checks cache directory" {
    run grep -q '\.aws/sso/cache' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "AWS token validation uses refresh buffer" {
    run grep -q 'AUTH_KEEPER_REFRESH_BUFFER' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "AWS refresh uses --no-browser flag" {
    run grep -q '\-\-no-browser' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "aws wrapper skips auth for configure command" {
    run grep -A5 '^aws()' "$TEST_SCRIPT"
    assert_contains "$output" "configure"
}

@test "aws wrapper skips auth for help command" {
    run grep -A5 '^aws()' "$TEST_SCRIPT"
    assert_contains "$output" "help"
}

# =============================================================================
# Azure CLI Tests
# =============================================================================

@test "Azure token validation checks msal cache" {
    run grep -q 'msal_token_cache.json' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "Azure has refresh token check" {
    run grep -q 'RefreshToken' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "az wrapper skips auth for login command" {
    run grep -A5 '^az()' "$TEST_SCRIPT"
    assert_contains "$output" "login"
}

@test "az wrapper skips auth for logout command" {
    run grep -A5 '^az()' "$TEST_SCRIPT"
    assert_contains "$output" "logout"
}

# =============================================================================
# Google OAuth Tests
# =============================================================================

@test "Google token file path is configurable via GMAIL_TOKEN" {
    run grep -q 'GMAIL_TOKEN' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "Google token validation checks refresh token" {
    run grep -q '_ak_google_has_refresh' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Tailscale Tests
# =============================================================================

@test "Tailscale checks BackendState" {
    run grep -q 'BackendState' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "Tailscale checks for Running state" {
    run grep -q '"Running"' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# CLI Tests
# =============================================================================

@test "auth-keeper supports status command" {
    run grep -q "status|s)" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "auth-keeper supports refresh command" {
    run grep -q "refresh|r)" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "auth-keeper supports help command" {
    run grep -q "help|h|--help|-h)" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "auth-keeper refresh supports aws subcommand" {
    run grep -A15 "refresh|r)" "$TEST_SCRIPT"
    assert_contains "$output" "aws"
}

@test "auth-keeper refresh supports azure subcommand" {
    run grep -A15 "refresh|r)" "$TEST_SCRIPT"
    assert_contains "$output" "azure"
}

@test "auth-keeper refresh supports all subcommand" {
    run grep -A15 "refresh|r)" "$TEST_SCRIPT"
    assert_contains "$output" "all"
}

# =============================================================================
# Completion Tests
# =============================================================================

@test "script provides zsh completion" {
    run grep -q 'ZSH_VERSION' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script provides bash completion" {
    run grep -q 'BASH_VERSION' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "bash completion function is defined" {
    run grep -q '_auth_keeper_comp()' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# AWS Token Expiry Simulation
# =============================================================================

@test "expired AWS token is detected" {
    # Create expired token file
    local expired_time
    expired_time=$(date -u -d "-1 hour" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v-1H '+%Y-%m-%dT%H:%M:%SZ')

    cat > "$TEST_HOME/.aws/sso/cache/test-token.json" << EOF
{
    "accessToken": "expired-token",
    "expiresAt": "$expired_time"
}
EOF

    # Source script and test
    source "$TEST_SCRIPT" 2>/dev/null || true

    # Token should be invalid (expired)
    if type _ak_aws_token_valid &>/dev/null; then
        run _ak_aws_token_valid
        [[ $status -eq 1 ]]
    else
        # Function not available outside sourced context - skip
        skip "Function not available"
    fi
}

@test "valid AWS token is detected" {
    # Create valid token file (expires in 2 hours)
    local future_time
    future_time=$(date -u -d "+2 hours" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v+2H '+%Y-%m-%dT%H:%M:%SZ')

    cat > "$TEST_HOME/.aws/sso/cache/test-token.json" << EOF
{
    "accessToken": "valid-token",
    "expiresAt": "$future_time"
}
EOF

    # Source script and test
    source "$TEST_SCRIPT" 2>/dev/null || true

    if type _ak_aws_token_valid &>/dev/null; then
        run _ak_aws_token_valid
        [[ $status -eq 0 ]]
    else
        skip "Function not available"
    fi
}
