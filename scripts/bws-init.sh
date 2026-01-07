#!/usr/bin/env bash
# bws-init - Initialize Bitwarden Secrets Manager CLI
# Source this file: source ~/bin/bws-init
set -uo pipefail

BWS_TOKEN_FILE="$HOME/.config/bws/access-token"

# Initialize BWS_ACCESS_TOKEN from file
_bws_init() {
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

    echo "Error: BWS access token not found"
    echo "Create $BWS_TOKEN_FILE with your machine account access token"
    echo "Or set BWS_ACCESS_TOKEN environment variable"
    return 1
}

# Get a secret value by name (key)
# Usage: bws_get "secret-name"
bws_get() {
    local secret_name="$1"

    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        _bws_init || return 1
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
        _bws_init || return 1
    fi

    bws secret list 2>/dev/null | jq -e --arg name "$secret_name" '.[] | select(.key == $name)' &>/dev/null
}

# List all available secrets (names only)
bws_list() {
    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        _bws_init || return 1
    fi

    bws secret list 2>/dev/null | jq -r '.[].key' | sort
}

# Initialize on source
_bws_init
