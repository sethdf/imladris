#!/usr/bin/env bash
# auth-keeper - Lazy authentication refresh for CLI tools
# Source this file in your shell: source ~/bin/auth-keeper
# Requires: jq, bws (for secrets)

# Configuration
AUTH_KEEPER_NOTIFY="${AUTH_KEEPER_NOTIFY:-signal}"  # signal, telegram, bell, none
AUTH_KEEPER_REFRESH_BUFFER=300  # Refresh 5 min before expiry

# ============================================================================
# Notification
# ============================================================================

_ak_notify() {
    local title="$1"
    local message="$2"

    case "$AUTH_KEEPER_NOTIFY" in
        signal)
            _ak_signal_send "$title: $message"
            ;;
        telegram)
            _ak_telegram_send "$title: $message"
            ;;
        bell)
            echo -e "\a[auth-keeper] $title: $message" >&2
            ;;
        none|*)
            echo "[auth-keeper] $title: $message" >&2
            ;;
    esac
}

_ak_signal_send() {
    local message="$1"
    if command -v signal-cli &>/dev/null; then
        local phone
        phone=$(bws_get "signal-phone" 2>/dev/null || echo "")
        if [[ -n "$phone" ]]; then
            signal-cli -u "$phone" send -m "$message" "$phone" &>/dev/null &
        fi
    fi
}

_ak_telegram_send() {
    local message="$1"
    local token chat_id
    token="${TELEGRAM_BOT_TOKEN:-$(bws_get 'telegram-bot-token' 2>/dev/null || echo '')}"
    chat_id="${TELEGRAM_CHAT_ID:-$(bws_get 'telegram-chat-id' 2>/dev/null || echo '')}"

    if [[ -n "$token" && -n "$chat_id" ]]; then
        curl -s "https://api.telegram.org/bot${token}/sendMessage" \
            -d "chat_id=${chat_id}" \
            -d "text=${message}" &>/dev/null &
    fi
}

# ============================================================================
# AWS SSO
# ============================================================================

_ak_aws_token_valid() {
    local cache_dir="$HOME/.aws/sso/cache"
    local now buffer
    now=$(date +%s)
    buffer=$AUTH_KEEPER_REFRESH_BUFFER

    for f in "$cache_dir"/*.json; do
        [[ -f "$f" ]] || continue

        if jq -e '.accessToken' "$f" &>/dev/null; then
            local expires_at
            expires_at=$(jq -r '.expiresAt // empty' "$f" 2>/dev/null)

            if [[ -n "$expires_at" ]]; then
                local exp_epoch
                exp_epoch=$(date -d "$expires_at" +%s 2>/dev/null)

                if [[ -n "$exp_epoch" ]] && (( exp_epoch - buffer > now )); then
                    return 0
                fi
            fi
        fi
    done
    return 1
}

_ak_aws_refresh() {
    local profile="${1:-${AWS_PROFILE:-}}"

    echo "[auth-keeper] AWS SSO login required" >&2

    # Use --no-browser to get device code
    local output
    if [[ -n "$profile" ]]; then
        output=$(command aws sso login --profile "$profile" --no-browser 2>&1)
    else
        output=$(command aws sso login --no-browser 2>&1)
    fi

    # Extract verification URL and code for notification
    local url code
    url=$(echo "$output" | grep -oP 'https://device\.sso\.[^[:space:]]+' | head -1)
    code=$(echo "$output" | grep -oP 'code:\s*\K[A-Z0-9-]+' | head -1)

    if [[ -n "$url" && -n "$code" ]]; then
        _ak_notify "AWS SSO" "Approve: $url (code: $code)"
    fi

    # Wait for approval (aws sso login --no-browser blocks until approved)
    echo "$output"
}

# shellcheck disable=SC2120
_ak_ensure_aws() {
    if ! _ak_aws_token_valid; then
        _ak_aws_refresh "$@"
    fi
}

# AWS wrapper
aws() {
    case "$1" in
        configure|help|--version|--help|sso)
            command aws "$@"
            return
            ;;
    esac

    _ak_ensure_aws "$@"
    command aws "$@"
}

# ============================================================================
# Azure CLI
# ============================================================================

_ak_azure_token_valid() {
    local cache_file="$HOME/.azure/msal_token_cache.json"
    [[ -f "$cache_file" ]] || return 1

    local now buffer
    now=$(date +%s)
    buffer=$AUTH_KEEPER_REFRESH_BUFFER

    local valid
    valid=$(jq -r --argjson now "$now" --argjson buf "$buffer" '
        .AccessToken // {} | to_entries[] |
        select((.value.expires_on | tonumber) - $buf > $now) |
        .key' "$cache_file" 2>/dev/null | head -1)

    [[ -n "$valid" ]]
}

_ak_azure_has_refresh() {
    local cache_file="$HOME/.azure/msal_token_cache.json"
    [[ -f "$cache_file" ]] && jq -e '.RefreshToken | length > 0' "$cache_file" &>/dev/null
}

_ak_azure_refresh() {
    if _ak_azure_has_refresh; then
        command az account get-access-token &>/dev/null
    else
        _ak_notify "Azure" "Interactive login required"
        command az login
    fi
}

_ak_ensure_azure() {
    if ! _ak_azure_token_valid; then
        echo "[auth-keeper] Azure token expired, refreshing..." >&2
        _ak_azure_refresh
    fi
}

# Azure wrapper
az() {
    case "$1" in
        login|logout|--version|--help|help)
            command az "$@"
            return
            ;;
    esac

    _ak_ensure_azure
    command az "$@"
}

# ============================================================================
# Google OAuth (for PAI skills)
# ============================================================================

_ak_google_token_file="${GMAIL_TOKEN:-$HOME/.config/gmail-cli/token.json}"

_ak_google_token_valid() {
    [[ -f "$_ak_google_token_file" ]] || return 1

    local now buffer expiry
    now=$(date +%s)
    buffer=$AUTH_KEEPER_REFRESH_BUFFER
    expiry=$(jq -r '.expiry_date // 0' "$_ak_google_token_file" 2>/dev/null)

    # expiry_date is in milliseconds
    (( expiry / 1000 - buffer > now ))
}

_ak_google_has_refresh() {
    [[ -f "$_ak_google_token_file" ]] && jq -e '.refresh_token' "$_ak_google_token_file" &>/dev/null
}

# ============================================================================
# Claude Code OAuth
# ============================================================================

_ak_claude_auth_file="${CLAUDE_AUTH_FILE:-$HOME/.config/claude/auth.json}"

_ak_claude_token_valid() {
    [[ -f "$_ak_claude_auth_file" ]] || return 1

    local now buffer expiry
    now=$(date +%s)
    buffer=$AUTH_KEEPER_REFRESH_BUFFER

    # Check for expiry field (formats may vary: expiresAt, expires_at, expiry)
    expiry=$(jq -r '.expiresAt // .expires_at // .expiry // 0' "$_ak_claude_auth_file" 2>/dev/null)

    # Handle both epoch seconds and ISO 8601 formats
    if [[ "$expiry" =~ ^[0-9]+$ ]]; then
        # Epoch timestamp - check if milliseconds or seconds
        if (( expiry > 9999999999 )); then
            # Milliseconds
            (( expiry / 1000 - buffer > now ))
        else
            # Seconds
            (( expiry - buffer > now ))
        fi
    elif [[ -n "$expiry" ]] && [[ "$expiry" != "0" ]]; then
        # ISO 8601 format
        local exp_epoch
        exp_epoch=$(date -d "$expiry" +%s 2>/dev/null)
        [[ -n "$exp_epoch" ]] && (( exp_epoch - buffer > now ))
    else
        # No expiry found, assume valid (will be checked on next API call)
        return 0
    fi
}

_ak_claude_has_refresh() {
    [[ -f "$_ak_claude_auth_file" ]] && jq -e '.refreshToken // .refresh_token' "$_ak_claude_auth_file" &>/dev/null
}

_ak_claude_refresh() {
    if ! _ak_claude_has_refresh; then
        _ak_notify "Claude Code" "No refresh token - interactive login required"
        echo "[auth-keeper] Claude Code: No refresh token available" >&2
        echo "[auth-keeper] You'll need to re-authenticate when you start Claude" >&2
        return 1
    fi

    # Claude Code should automatically refresh tokens on startup if refresh token exists
    # We don't manually refresh here - just validate that refresh token exists
    echo "[auth-keeper] Claude Code: Refresh token present, will auto-refresh on startup" >&2
    return 0
}

_ak_ensure_claude() {
    if ! _ak_claude_token_valid; then
        echo "[auth-keeper] Claude Code token expired or missing" >&2
        _ak_claude_refresh
    fi
}

# Optional: Wrapper for claude command (uncomment to enable)
# claude() {
#     _ak_ensure_claude || echo "[auth-keeper] Warning: Claude tokens may be expired" >&2
#     command claude "$@"
# }

# ============================================================================
# Tailscale
# ============================================================================

_ak_tailscale_connected() {
    local state
    state=$(tailscale status --json 2>/dev/null | jq -r '.BackendState' 2>/dev/null)
    [[ "$state" == "Running" ]]
}

# ============================================================================
# Status & CLI
# ============================================================================

auth-keeper() {
    case "${1:-status}" in
        status|s)
            echo "=== auth-keeper status ==="

            # AWS SSO
            if _ak_aws_token_valid; then
                local exp
                exp=$(find "$HOME/.aws/sso/cache" -name '*.json' -exec jq -r '.expiresAt // empty' {} \; 2>/dev/null | grep -v '^$' | head -1)
                echo "aws-sso: valid (expires $exp)"
            else
                echo "aws-sso: expired"
            fi

            # Azure
            if _ak_azure_token_valid; then
                echo "azure: valid"
            elif _ak_azure_has_refresh; then
                echo "azure: expired (has refresh token)"
            else
                echo "azure: expired (needs login)"
            fi

            # Google
            if _ak_google_token_valid; then
                echo "google: valid"
            elif _ak_google_has_refresh; then
                echo "google: expired (has refresh token)"
            elif [[ -f "$_ak_google_token_file" ]]; then
                echo "google: expired"
            else
                echo "google: not configured"
            fi

            # Claude Code
            if _ak_claude_token_valid; then
                echo "claude-code: valid"
            elif _ak_claude_has_refresh; then
                echo "claude-code: expired (has refresh token)"
            elif [[ -f "$_ak_claude_auth_file" ]]; then
                echo "claude-code: expired (no refresh token)"
            else
                echo "claude-code: using bedrock or not configured"
            fi

            # Tailscale
            if command -v tailscale &>/dev/null; then
                if _ak_tailscale_connected; then
                    local ip
                    ip=$(tailscale ip -4 2>/dev/null)
                    echo "tailscale: connected ($ip)"
                else
                    echo "tailscale: disconnected"
                fi
            else
                echo "tailscale: not installed"
            fi
            ;;

        refresh|r)
            case "${2:-}" in
                aws|aws-sso)
                    _ak_aws_refresh "${3:-}"
                    ;;
                azure|az)
                    _ak_azure_refresh
                    ;;
                all)
                    _ak_aws_refresh
                    _ak_azure_refresh
                    ;;
                *)
                    echo "Usage: auth-keeper refresh [aws|azure|all]"
                    ;;
            esac
            ;;

        help|h|--help|-h)
            cat <<'EOF'
auth-keeper - Lazy authentication management

Usage: auth-keeper [command]

Commands:
  status    Show status of all services
  refresh   Force refresh (aws, azure, all)
  help      Show this help

Environment:
  AUTH_KEEPER_NOTIFY         signal, telegram, bell, none (default: signal)
  AUTH_KEEPER_REFRESH_BUFFER Seconds before expiry to refresh (default: 300)

Wrappers (auto-refresh on use):
  aws       Wraps AWS CLI, refreshes SSO if expired
  az        Wraps Azure CLI, uses refresh tokens
EOF
            ;;

        *)
            echo "Unknown: $1 (try: auth-keeper help)"
            return 1
            ;;
    esac
}

# Completion
if [[ -n "${ZSH_VERSION:-}" ]]; then
    compdef '_arguments "1:command:(status refresh help)" "2:service:(aws azure all)"' auth-keeper
elif [[ -n "${BASH_VERSION:-}" ]]; then
    _auth_keeper_comp() {
        local cur="${COMP_WORDS[COMP_CWORD]}"
        case "${COMP_WORDS[1]:-}" in
            refresh) mapfile -t COMPREPLY < <(compgen -W "aws azure all" -- "$cur") ;;
            *) mapfile -t COMPREPLY < <(compgen -W "status refresh help" -- "$cur") ;;
        esac
    }
    complete -F _auth_keeper_comp auth-keeper
fi
