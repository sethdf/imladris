#!/usr/bin/env bash
# bws-init - Initialize Bitwarden Secrets Manager CLI
# Source this file: source ~/bin/bws-init
set -uo pipefail

BWS_TOKEN_FILE="$HOME/.config/bws/access-token"

# Initialize BWS_ACCESS_TOKEN from file
_bws_init() {
    local verbose="${1:-false}"

    # Already set?
    if [[ -n "${BWS_ACCESS_TOKEN:-}" ]]; then
        return 0
    fi

    # Load from file
    if [[ -f "$BWS_TOKEN_FILE" ]]; then
        BWS_ACCESS_TOKEN=$(cat "$BWS_TOKEN_FILE")
        export BWS_ACCESS_TOKEN
        return 0
    fi

    # Also check LUKS-encrypted location
    local luks_token_file="/data/.secrets/bws-token"
    if [[ -f "$luks_token_file" ]]; then
        BWS_ACCESS_TOKEN=$(cat "$luks_token_file")
        export BWS_ACCESS_TOKEN
        return 0
    fi

    # Only show error if verbose (called by a function that needs the token)
    if [[ "$verbose" == "true" ]]; then
        echo "Error: BWS access token not found" >&2
        echo "Run 'imladris-init' to set up BWS access" >&2
    fi
    return 1
}

# Get a secret value by name (key)
# Usage: bws_get "secret-name"
bws_get() {
    local secret_name="$1"

    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        _bws_init true || return 1
    fi

    # List all secrets and find by key name, then get the value
    local secret_id
    secret_id=$(bws secret list 2>/dev/null | jq -r --arg name "$secret_name" '.[] | select(.key == $name) | .id' 2>/dev/null)

    if [[ -z "$secret_id" ]]; then
        echo "Error: Secret '$secret_name' not found" >&2
        return 1
    fi

    bws secret get "$secret_id" 2>/dev/null | jq -r '.value'
}

# Check if a secret exists by name
# Usage: bws_exists "secret-name"
bws_exists() {
    local secret_name="$1"

    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        _bws_init true || return 1
    fi

    bws secret list 2>/dev/null | jq -e --arg name "$secret_name" '.[] | select(.key == $name)' &>/dev/null
}

# List all available secrets (names only)
bws_list() {
    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        _bws_init true || return 1
    fi

    bws secret list 2>/dev/null | jq -r '.[].key' | sort
}

# Set/create a secret value by name
# Usage: bws_set "secret-name" "value"
bws_set() {
    local secret_name="$1"
    local secret_value="$2"
    local project_id="eb9c4741-f9d9-4b7f-a532-b3cb00fe8e1a"  # imladris project

    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        _bws_init true || return 1
    fi

    # Check if secret exists
    local secret_id
    secret_id=$(bws secret list 2>/dev/null | jq -r --arg name "$secret_name" '.[] | select(.key == $name) | .id' 2>/dev/null)

    if [[ -n "$secret_id" ]]; then
        # Update existing secret
        bws secret edit "$secret_id" --value "$secret_value" >/dev/null 2>&1
    else
        # Create new secret
        bws secret create "$secret_name" "$secret_value" "$project_id" >/dev/null 2>&1
    fi
}

# Initialize on source
_bws_init
