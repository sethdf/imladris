#!/usr/bin/env bash
# auth-keeper - Unified authentication and service access
# Source this file in your shell: source ~/bin/auth-keeper
# Requires: jq, bws (for secrets), pwsh (for ms365)

# Configuration
AUTH_KEEPER_NOTIFY="${AUTH_KEEPER_NOTIFY:-signal}"  # signal (default), telegram, bell, none
AUTH_KEEPER_REFRESH_BUFFER=300  # Refresh 5 min before expiry

# ============================================================================
# Notification
# ============================================================================

_ak_notify() {
    local title="$1"
    local message="$2"

    case "$AUTH_KEEPER_NOTIFY" in
        signal)
            # Send via Signal REST API
            local phone
            phone="${SIGNAL_PHONE:-$(_ak_bws_get 'signal-phone' 2>/dev/null)}"
            if [[ -n "$phone" ]]; then
                curl -s "${SIGNAL_API_URL:-http://127.0.0.1:8080}/v1/send" -X POST \
                    -H "Content-Type: application/json" \
                    -d "$(jq -n --arg msg "$title: $message" --arg num "$phone" \
                        '{message:$msg,number:$num,recipients:[$num]}')" &>/dev/null &
            fi
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
# BWS Helper
# ============================================================================

# BWS cache for this session (avoids intermittent failures and redundant calls)
_ak_bws_cache=""
_ak_bws_cache_time=0

_ak_bws_get() {
    local key="$1"
    local now result

    # Cache BWS list for 60 seconds
    now=$(date +%s)
    if [[ -z "$_ak_bws_cache" || $((now - _ak_bws_cache_time)) -gt 60 ]]; then
        local attempts=0
        while [[ $attempts -lt 3 ]]; do
            _ak_bws_cache=$(bws secret list 2>/dev/null)
            if [[ -n "$_ak_bws_cache" && "$_ak_bws_cache" != "[]" ]]; then
                _ak_bws_cache_time=$now
                break
            fi
            ((attempts++))
            sleep 0.5
        done
    fi

    echo "$_ak_bws_cache" | jq -r --arg k "$key" '.[] | select(.key == $k) | .value'
}

# ============================================================================
# AWS SSO
# ============================================================================

_ak_aws_token_valid() {
    local cache_dir="$HOME/.aws/sso/cache"
    [[ -d "$cache_dir" ]] || return 1

    local now buffer
    now=$(date +%s)
    buffer=$AUTH_KEEPER_REFRESH_BUFFER

    local files=("$cache_dir"/*.json)
    [[ -e "${files[0]}" ]] || return 1

    for f in "${files[@]}"; do
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

    local output
    if [[ -n "$profile" ]]; then
        output=$(command aws sso login --profile "$profile" --no-browser 2>&1)
    else
        output=$(command aws sso login --no-browser 2>&1)
    fi

    local url code
    url=$(echo "$output" | grep -oP 'https://device\.sso\.[^[:space:]]+' | head -1)
    code=$(echo "$output" | grep -oP 'code:\s*\K[A-Z0-9-]+' | head -1)

    if [[ -n "$url" && -n "$code" ]]; then
        _ak_notify "AWS SSO" "Approve: $url (code: $code)"
    fi

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
# MS365 - Service Principal (mail, calendar, teams, sharepoint, etc.)
# ============================================================================

_ak_ms365_tenant_id="99cc3795-3b94-4c8f-a292-8c4c153771a5"
_ak_ms365_user="sfoley@buxtonco.com"

_ak_ms365_get_creds() {
    local secrets
    secrets=$(bws secret list 2>/dev/null) || {
        echo "Error: BWS not available. Run: bws login" >&2
        return 1
    }

    _ak_ms365_client_id=$(echo "$secrets" | jq -r '.[] | select(.key == "m365-client-id") | .value')
    _ak_ms365_client_secret=$(echo "$secrets" | jq -r '.[] | select(.key == "m365-client-secret") | .value')

    if [[ -z "$_ak_ms365_client_id" || -z "$_ak_ms365_client_secret" ]]; then
        echo "Error: m365-client-id or m365-client-secret not found in BWS" >&2
        return 1
    fi
}

_ak_ms365_preamble() {
    cat <<PREAMBLE
\$ErrorActionPreference = 'Stop'
\$clientSecret = ConvertTo-SecureString '$_ak_ms365_client_secret' -AsPlainText -Force
\$credential = New-Object System.Management.Automation.PSCredential('$_ak_ms365_client_id', \$clientSecret)
Connect-MgGraph -TenantId '$_ak_ms365_tenant_id' -ClientSecretCredential \$credential -NoWelcome
PREAMBLE
}

_ak_ms365_cmd() {
    _ak_ms365_get_creds || return 1
    local cmd="$1"

    pwsh -Command "$(_ak_ms365_preamble)
$cmd"
}

_ak_ms365_interactive() {
    _ak_ms365_get_creds || return 1

    local profile
    profile=$(mktemp --suffix=.ps1)
    cat > "$profile" <<EOF
$(_ak_ms365_preamble)
Write-Host "Connected to MS365 as service principal" -ForegroundColor Green
Write-Host "User: $_ak_ms365_user | Tenant: $_ak_ms365_tenant_id" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Quick reference:" -ForegroundColor Yellow
Write-Host "  Get-MgUserMessage -UserId '$_ak_ms365_user' -Top 10"
Write-Host "  Get-MgUserMessage -UserId '$_ak_ms365_user' -Filter 'isRead eq false' -CountVariable c -Top 1; \\\$c"
Write-Host "  Get-MgUserCalendarEvent -UserId '$_ak_ms365_user'"
Write-Host "  Get-MgUser -UserId '$_ak_ms365_user'"
Write-Host ""
EOF

    pwsh -NoLogo -NoProfile -Command ". '$profile'; Remove-Item '$profile'; \$host.UI.RawUI.WindowTitle = 'MS365 PowerShell'"
}

_ak_ms365_configured() {
    bws secret list 2>/dev/null | jq -e '.[] | select(.key == "m365-client-id")' &>/dev/null
}

# ============================================================================
# Google - OAuth2 Delegated (gmail, calendar)
# ============================================================================

_ak_google_get_creds() {
    local secrets
    secrets=$(bws secret list 2>/dev/null) || {
        echo "Error: BWS not available. Run: bws login" >&2
        return 1
    }

    local client_json
    client_json=$(echo "$secrets" | jq -r '.[] | select(.key == "gcp-oauth-client-json") | .value')

    if [[ -z "$client_json" ]]; then
        echo "Error: gcp-oauth-client-json not found in BWS" >&2
        return 1
    fi

    _ak_google_client_id=$(echo "$client_json" | jq -r '.installed.client_id // .web.client_id')
    _ak_google_client_secret=$(echo "$client_json" | jq -r '.installed.client_secret // .web.client_secret')
    _ak_google_refresh_token=$(echo "$secrets" | jq -r '.[] | select(.key == "gcp-oauth-refresh-token") | .value')
}

_ak_google_token_valid() {
    # Check keyring for cached token
    local expiry
    expiry=$(secret-tool lookup service imladris-google type expiry 2>/dev/null || echo "0")

    local now buffer
    now=$(date +%s)
    buffer=$AUTH_KEEPER_REFRESH_BUFFER

    [[ -n "$expiry" ]] && (( expiry - buffer > now ))
}

_ak_google_get_access_token() {
    # Return cached token if valid
    if _ak_google_token_valid; then
        secret-tool lookup service imladris-google type access-token 2>/dev/null
        return 0
    fi

    # Refresh token
    _ak_google_get_creds || return 1

    if [[ -z "$_ak_google_refresh_token" ]]; then
        echo "Error: No refresh token. Run: auth-keeper google --auth" >&2
        return 1
    fi

    local response
    response=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
        -d "client_id=$_ak_google_client_id" \
        -d "client_secret=$_ak_google_client_secret" \
        -d "grant_type=refresh_token" \
        -d "refresh_token=$_ak_google_refresh_token")

    if echo "$response" | jq -e '.access_token' &>/dev/null; then
        local access_token expires_in expiry_time
        access_token=$(echo "$response" | jq -r '.access_token')
        expires_in=$(echo "$response" | jq -r '.expires_in')
        expiry_time=$(($(date +%s) + expires_in))

        # Cache in keyring
        echo -n "$access_token" | secret-tool store --label="google-access-token" service imladris-google type access-token
        echo -n "$expiry_time" | secret-tool store --label="google-expiry" service imladris-google type expiry

        echo "$access_token"
        return 0
    else
        echo "Error: Token refresh failed: $(echo "$response" | jq -r '.error_description // .error')" >&2
        return 1
    fi
}

_ak_google_auth() {
    _ak_google_get_creds || return 1

    local scopes="https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar"
    local auth_url="https://accounts.google.com/o/oauth2/v2/auth?client_id=$_ak_google_client_id&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=$(echo "$scopes" | sed 's/ /%20/g')&access_type=offline&prompt=consent"

    echo "Open this URL in your browser:"
    echo ""
    echo "$auth_url"
    echo ""
    read -rp "Enter the authorization code: " auth_code

    local response
    response=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
        -d "client_id=$_ak_google_client_id" \
        -d "client_secret=$_ak_google_client_secret" \
        -d "code=$auth_code" \
        -d "grant_type=authorization_code" \
        -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob")

    if echo "$response" | jq -e '.refresh_token' &>/dev/null; then
        local refresh_token access_token expires_in expiry_time
        refresh_token=$(echo "$response" | jq -r '.refresh_token')
        access_token=$(echo "$response" | jq -r '.access_token')
        expires_in=$(echo "$response" | jq -r '.expires_in')
        expiry_time=$(($(date +%s) + expires_in))

        # Store refresh token in BWS
        echo "Storing refresh token in BWS..."
        bws secret edit gcp-oauth-refresh-token --value "$refresh_token" 2>/dev/null || \
            bws secret create gcp-oauth-refresh-token "$refresh_token" 2>/dev/null

        # Cache access token in keyring
        echo -n "$access_token" | secret-tool store --label="google-access-token" service imladris-google type access-token
        echo -n "$expiry_time" | secret-tool store --label="google-expiry" service imladris-google type expiry

        echo "Google OAuth configured successfully!"
        return 0
    else
        echo "Error: Auth failed: $(echo "$response" | jq -r '.error_description // .error')" >&2
        return 1
    fi
}

_ak_google_configured() {
    bws secret list 2>/dev/null | jq -e '.[] | select(.key == "gcp-oauth-client-json")' &>/dev/null
}

_ak_google_has_refresh() {
    local rt
    rt=$(_ak_bws_get "gcp-oauth-refresh-token")
    [[ -n "$rt" ]]
}

# Google API helper
_ak_google_api() {
    local method="$1"
    local endpoint="$2"
    shift 2

    local token
    token=$(_ak_google_get_access_token) || return 1

    curl -s -X "$method" "https://www.googleapis.com/$endpoint" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        "$@"
}

# ============================================================================
# Slack - Bot API
# ============================================================================

_ak_slack_get_bot_token() {
    local token
    token="${SLACK_BOT_TOKEN:-$(_ak_bws_get 'slack-bot-token')}"

    if [[ -z "$token" ]]; then
        echo "Error: No Slack bot token. Set SLACK_BOT_TOKEN or add slack-bot-token to BWS" >&2
        return 1
    fi
    echo "$token"
}

_ak_slack_get_user_token() {
    local token
    token="${SLACK_USER_TOKEN:-$(_ak_bws_get 'slack-user-token')}"

    if [[ -z "$token" ]]; then
        echo "Error: No Slack user token. Set SLACK_USER_TOKEN or add slack-user-token to BWS" >&2
        return 1
    fi
    echo "$token"
}

# Bot token API (for sending, listing)
_ak_slack_api() {
    local method="$1"
    shift
    local token
    token=$(_ak_slack_get_bot_token) || return 1

    curl -s "https://slack.com/api/$method" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json; charset=utf-8" \
        "$@"
}

# User token API (for unreads, history)
_ak_slack_user_api() {
    local method="$1"
    shift
    local token
    token=$(_ak_slack_get_user_token) || return 1

    curl -s "https://slack.com/api/$method" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json; charset=utf-8" \
        "$@"
}

_ak_slack_configured() {
    local token
    token="${SLACK_BOT_TOKEN:-$(_ak_bws_get 'slack-bot-token' 2>/dev/null)}"
    [[ -n "$token" ]]
}

_ak_slack_user_configured() {
    local token
    token="${SLACK_USER_TOKEN:-$(_ak_bws_get 'slack-user-token' 2>/dev/null)}"
    [[ -n "$token" ]]
}

# ============================================================================
# Telegram - Bot API
# ============================================================================

_ak_telegram_get_token() {
    local token
    token="${TELEGRAM_BOT_TOKEN:-$(_ak_bws_get 'telegram-bot-token')}"

    if [[ -z "$token" ]]; then
        echo "Error: No Telegram token. Set TELEGRAM_BOT_TOKEN or add telegram-bot-token to BWS" >&2
        return 1
    fi
    echo "$token"
}

_ak_telegram_get_chat() {
    local chat
    chat="${TELEGRAM_CHAT_ID:-$(_ak_bws_get 'telegram-chat-id')}"

    if [[ -z "$chat" ]]; then
        echo "Error: No default chat. Set TELEGRAM_CHAT_ID or add telegram-chat-id to BWS" >&2
        return 1
    fi
    echo "$chat"
}

_ak_telegram_api() {
    local method="$1"
    shift
    local token
    token=$(_ak_telegram_get_token) || return 1

    curl -s "https://api.telegram.org/bot${token}/${method}" \
        -H "Content-Type: application/json" \
        "$@"
}

_ak_telegram_configured() {
    local token
    token="${TELEGRAM_BOT_TOKEN:-$(_ak_bws_get 'telegram-bot-token' 2>/dev/null)}"
    [[ -n "$token" ]]
}

# ============================================================================
# Signal - REST API (signal-cli-rest-api Docker container)
# ============================================================================

SIGNAL_API_URL="${SIGNAL_API_URL:-http://127.0.0.1:8080}"

_ak_signal_get_phone() {
    local phone
    phone="${SIGNAL_PHONE:-$(_ak_bws_get 'signal-phone')}"

    if [[ -z "$phone" ]]; then
        echo "Error: No Signal phone. Set SIGNAL_PHONE or add signal-phone to BWS" >&2
        return 1
    fi
    echo "$phone"
}

_ak_signal_api() {
    local endpoint="$1"
    shift
    curl -s "${SIGNAL_API_URL}${endpoint}" "$@"
}

_ak_signal_configured() {
    # Check if API is reachable and has accounts
    local accounts
    accounts=$(curl -s --max-time 2 "${SIGNAL_API_URL}/v1/accounts" 2>/dev/null)
    [[ -n "$accounts" && "$accounts" != "[]" ]]
}

_ak_signal_api_running() {
    curl -s --max-time 1 "${SIGNAL_API_URL}/v1/about" &>/dev/null
}

# ============================================================================
# SDP (ServiceDesk Plus Cloud) - OAuth 2.0 REST API
# ============================================================================

_ak_sdp_user="sfoley@buxtonco.com"
_ak_sdp_token_cache_file="/tmp/.sdp_token_cache_$$"

# Ensure token is fresh (call before using _ak_sdp_token)
_ak_sdp_ensure_token() {
    local now cached_expiry cached_token
    now=$(date +%s)

    # Check cache file
    if [[ -f "$_ak_sdp_token_cache_file" ]]; then
        cached_expiry=$(head -1 "$_ak_sdp_token_cache_file" 2>/dev/null || echo "0")
        cached_token=$(tail -1 "$_ak_sdp_token_cache_file" 2>/dev/null || echo "")

        # Return cached token if still valid (with 5 min buffer)
        if [[ -n "$cached_token" && "$cached_expiry" -gt $((now + 300)) ]]; then
            _ak_sdp_token="$cached_token"
            return 0
        fi
    fi

    # Get OAuth credentials from BWS
    local client_id client_secret refresh_token
    client_id="${SDP_CLIENT_ID:-$(_ak_bws_get 'sdp-client-id')}"
    client_secret="${SDP_CLIENT_SECRET:-$(_ak_bws_get 'sdp-client-secret')}"
    refresh_token="${SDP_REFRESH_TOKEN:-$(_ak_bws_get 'sdp-refresh-token')}"

    if [[ -z "$client_id" || -z "$client_secret" || -z "$refresh_token" ]]; then
        echo "Error: Missing SDP OAuth credentials in BWS (sdp-client-id, sdp-client-secret, sdp-refresh-token)" >&2
        return 1
    fi

    # Exchange refresh token for access token
    local response
    response=$(curl -s -X POST "https://accounts.zoho.com/oauth/v2/token" \
        -d "grant_type=refresh_token" \
        -d "client_id=$client_id" \
        -d "client_secret=$client_secret" \
        -d "refresh_token=$refresh_token")

    local access_token expires_in
    access_token=$(echo "$response" | jq -r '.access_token // empty')
    expires_in=$(echo "$response" | jq -r '.expires_in // 3600')

    if [[ -z "$access_token" ]]; then
        echo "Error: Failed to get SDP access token: $(echo "$response" | jq -r '.error // "unknown"')" >&2
        return 1
    fi

    # Cache to file (expiry on line 1, token on line 2)
    echo "$((now + expires_in))" > "$_ak_sdp_token_cache_file"
    echo "$access_token" >> "$_ak_sdp_token_cache_file"
    chmod 600 "$_ak_sdp_token_cache_file"

    _ak_sdp_token="$access_token"
}

_ak_sdp_creds_loaded=""

_ak_sdp_get_creds() {
    # Idempotent - only load once per session
    if [[ -n "$_ak_sdp_creds_loaded" && -n "$_ak_sdp_base_url" ]]; then
        return 0
    fi

    _ak_sdp_base_url="${SDP_BASE_URL:-$(_ak_bws_get 'sdp-base-url')}"

    if [[ -z "$_ak_sdp_base_url" ]]; then
        echo "Error: No SDP base URL. Set SDP_BASE_URL or add sdp-base-url to BWS" >&2
        return 1
    fi

    # Ensure we have a fresh token
    _ak_sdp_ensure_token || return 1
    _ak_sdp_creds_loaded="1"
}

_ak_sdp_api() {
    local method="$1"
    local endpoint="$2"
    shift 2

    _ak_sdp_get_creds || return 1

    curl -s -X "$method" "${_ak_sdp_base_url}${endpoint}" \
        -H "Authorization: Zoho-oauthtoken $_ak_sdp_token" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        "$@"
}

_ak_sdp_configured() {
    local refresh url
    refresh="${SDP_REFRESH_TOKEN:-$(_ak_bws_get 'sdp-refresh-token' 2>/dev/null)}"
    url="${SDP_BASE_URL:-$(_ak_bws_get 'sdp-base-url' 2>/dev/null)}"
    [[ -n "$refresh" && -n "$url" ]]
}

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

            # MS365 (service principal)
            if _ak_ms365_configured; then
                echo "ms365: configured (service principal - always valid)"
            else
                echo "ms365: not configured (need m365-client-id in BWS)"
            fi

            # Google
            if _ak_google_configured; then
                if _ak_google_token_valid; then
                    local exp_time remaining hours mins
                    exp_time=$(secret-tool lookup service imladris-google type expiry 2>/dev/null || echo "0")
                    remaining=$((exp_time - $(date +%s)))
                    hours=$((remaining / 3600))
                    mins=$(((remaining % 3600) / 60))
                    echo "google: valid (expires in ${hours}h ${mins}m)"
                elif _ak_google_has_refresh; then
                    echo "google: expired (has refresh token - will auto-refresh)"
                else
                    echo "google: configured but no tokens (run 'auth-keeper google --auth')"
                fi
            else
                echo "google: not configured (need gcp-oauth-client-json in BWS)"
            fi

            # Slack
            if _ak_slack_configured; then
                echo "slack: configured (bot token)"
            else
                echo "slack: not configured (need slack-bot-token in BWS)"
            fi

            # Telegram
            if _ak_telegram_configured; then
                local chat_id
                chat_id="${TELEGRAM_CHAT_ID:-$(_ak_bws_get 'telegram-chat-id' 2>/dev/null)}"
                if [[ -n "$chat_id" ]]; then
                    echo "telegram: configured (chat: $chat_id)"
                else
                    echo "telegram: configured (no default chat)"
                fi
            else
                echo "telegram: not configured (need telegram-bot-token in BWS)"
            fi

            # Signal
            if _ak_signal_api_running; then
                if _ak_signal_configured; then
                    local phone
                    phone=$(_ak_bws_get 'signal-phone' 2>/dev/null)
                    echo "signal: configured (phone: $phone)"
                else
                    echo "signal: API running but not linked (run: auth-keeper signal link)"
                fi
            else
                echo "signal: API not running (docker start signal-cli-rest-api)"
            fi

            # SDP (ServiceDesk Plus)
            if _ak_sdp_configured; then
                echo "sdp: configured (user: $_ak_sdp_user)"
            else
                echo "sdp: not configured (need sdp-api-key and sdp-base-url in BWS)"
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

        ms365|m365)
            shift
            case "${1:-}" in
                ""|"-i"|"--interactive")
                    _ak_ms365_interactive
                    ;;
                "-h"|"--help")
                    cat <<'EOF'
auth-keeper ms365 - MS365 PowerShell access (service principal)

Usage:
  auth-keeper ms365                    Interactive PowerShell session
  auth-keeper ms365 "command"          Run a single PowerShell command
  auth-keeper ms365 -h                 Show this help

Examples:
  auth-keeper ms365 "Get-MgUserMessage -UserId 'sfoley@buxtonco.com' -Top 10"
  auth-keeper ms365 "Get-MgUserMessage -UserId 'sfoley@buxtonco.com' -Filter 'isRead eq false' -CountVariable c -Top 1; \$c"
  auth-keeper ms365 "Get-MgUserCalendarEvent -UserId 'sfoley@buxtonco.com'"
EOF
                    ;;
                *)
                    _ak_ms365_cmd "$1"
                    ;;
            esac
            ;;

        google|g)
            shift
            case "${1:-}" in
                "--auth")
                    _ak_google_auth
                    ;;
                "--token")
                    _ak_google_get_access_token
                    ;;
                "-h"|"--help")
                    cat <<'EOF'
auth-keeper google - Google API access (OAuth2)

Usage:
  auth-keeper google --auth            Authenticate (get refresh token)
  auth-keeper google --token           Get current access token
  auth-keeper google mail              List recent emails
  auth-keeper google calendar          List today's calendar events
  auth-keeper google -h                Show this help

Examples:
  auth-keeper google mail
  auth-keeper google calendar
EOF
                    ;;
                "mail"|"gmail")
                    local response
                    response=$(_ak_google_api GET "gmail/v1/users/me/messages?maxResults=10&q=is:unread")

                    if echo "$response" | jq -e '.messages' &>/dev/null; then
                        local count
                        count=$(echo "$response" | jq -r '.resultSizeEstimate // 0')
                        echo "Unread emails: ~$count"
                        echo ""

                        # Get details for each message
                        echo "$response" | jq -r '.messages[]?.id' | head -5 | while read -r msg_id; do
                            local msg
                            msg=$(_ak_google_api GET "gmail/v1/users/me/messages/$msg_id?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date")

                            local subject from date
                            subject=$(echo "$msg" | jq -r '.payload.headers[] | select(.name == "Subject") | .value' | head -c 60)
                            from=$(echo "$msg" | jq -r '.payload.headers[] | select(.name == "From") | .value' | head -c 30)
                            date=$(echo "$msg" | jq -r '.payload.headers[] | select(.name == "Date") | .value' | head -c 25)

                            printf "%-25s | %-30s | %s\n" "$date" "$from" "$subject"
                        done
                    else
                        echo "Error: $(echo "$response" | jq -r '.error.message // "Unknown error"')" >&2
                    fi
                    ;;
                "calendar"|"cal")
                    local now tomorrow
                    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
                    tomorrow=$(date -u -d "+1 day" +%Y-%m-%dT%H:%M:%SZ)

                    local response
                    response=$(_ak_google_api GET "calendar/v3/calendars/primary/events?timeMin=$now&timeMax=$tomorrow&singleEvents=true&orderBy=startTime")

                    if echo "$response" | jq -e '.items' &>/dev/null; then
                        echo "Today's events:"
                        echo ""
                        echo "$response" | jq -r '.items[] | "\(.start.dateTime // .start.date | .[11:16] // "All day") | \(.summary)"'
                    else
                        echo "Error: $(echo "$response" | jq -r '.error.message // "Unknown error"')" >&2
                    fi
                    ;;
                *)
                    echo "Unknown google command: $1 (try: auth-keeper google -h)"
                    return 1
                    ;;
            esac
            ;;

        slack|sl)
            shift
            case "${1:-}" in
                ""|"triage")
                    # Show recent activity - channels with unread, DMs, mentions
                    echo "Checking Slack activity..."
                    local response
                    response=$(_ak_slack_api "conversations.list" -d '{"types":"public_channel,private_channel,im","limit":50}')

                    if echo "$response" | jq -e '.ok' &>/dev/null && [[ $(echo "$response" | jq -r '.ok') == "true" ]]; then
                        echo ""
                        echo "Channels:"
                        echo "$response" | jq -r '.channels[] | select(.is_member == true) | "  \(if .is_private then "🔒" else "#" end)\(.name // "DM") [\(.id)]"' | head -20
                    else
                        echo "Error: $(echo "$response" | jq -r '.error // "Unknown error"')" >&2
                    fi
                    ;;
                "unread"|"u")
                    # Show unread counts (requires user token)
                    if ! _ak_slack_user_configured; then
                        echo "Error: Unread counts require user token (slack-user-token in BWS)" >&2
                        echo "See: auth-keeper slack -h" >&2
                        return 1
                    fi

                    echo "Fetching unread counts..."
                    local token has_unread=false
                    token=$(_ak_slack_get_user_token) || return 1

                    # Query each channel type separately (GET params required)
                    for ch_type in "im" "mpim" "private_channel" "public_channel"; do
                        local response
                        response=$(curl -s "https://slack.com/api/conversations.list?types=$ch_type&limit=200&exclude_archived=true" \
                            -H "Authorization: Bearer $token")

                        if [[ $(echo "$response" | jq -r '.ok') != "true" ]]; then
                            continue
                        fi

                        # Check each channel for unread messages
                        while IFS= read -r ch_id; do
                            [[ -z "$ch_id" ]] && continue
                            local info
                            info=$(curl -s "https://slack.com/api/conversations.info?channel=$ch_id" \
                                -H "Authorization: Bearer $token")

                            local unread_count name is_im is_private
                            unread_count=$(echo "$info" | jq -r '.channel.unread_count // 0')
                            [[ "$unread_count" == "null" ]] && unread_count=0

                            if [[ "$unread_count" -gt 0 ]]; then
                                has_unread=true
                                name=$(echo "$info" | jq -r '.channel.name // empty')
                                is_im=$(echo "$info" | jq -r '.channel.is_im // false')
                                is_private=$(echo "$info" | jq -r '.channel.is_private // false')

                                # For DMs, resolve user name
                                if [[ "$is_im" == "true" ]]; then
                                    local user_id
                                    user_id=$(echo "$info" | jq -r '.channel.user')
                                    local user_info
                                    user_info=$(curl -s "https://slack.com/api/users.info?user=$user_id" \
                                        -H "Authorization: Bearer $token")
                                    name=$(echo "$user_info" | jq -r '.user.real_name // .user.name // empty')
                                    [[ -z "$name" ]] && name="DM ($user_id)"
                                    printf "  💬 %-25s %d unread\n" "$name" "$unread_count"
                                elif [[ "$is_private" == "true" ]]; then
                                    printf "  🔒 %-25s %d unread\n" "$name" "$unread_count"
                                else
                                    printf "  #  %-25s %d unread\n" "$name" "$unread_count"
                                fi
                            fi
                        done < <(echo "$response" | jq -r '.channels[].id')
                    done

                    if [[ "$has_unread" == "false" ]]; then
                        echo ""
                        echo "  No unread messages!"
                    fi
                    ;;
                "channels"|"ch")
                    local response
                    response=$(_ak_slack_api "conversations.list" -d '{"types":"public_channel,private_channel","limit":100}')

                    if echo "$response" | jq -e '.ok' &>/dev/null && [[ $(echo "$response" | jq -r '.ok') == "true" ]]; then
                        echo "Channels:"
                        echo ""
                        echo "$response" | jq -r '.channels[] | "  \(if .is_private then "🔒" else "#" end)\(.name) (\(.num_members) members) [\(.id)]"'
                    else
                        echo "Error: $(echo "$response" | jq -r '.error // "Unknown error"')" >&2
                    fi
                    ;;
                "read"|"r")
                    # Read requires user token for channels:history scope
                    if ! _ak_slack_user_configured; then
                        echo "Error: Reading messages requires user token (slack-user-token in BWS)" >&2
                        echo "See: auth-keeper slack -h" >&2
                        return 1
                    fi

                    local channel="${2:?Usage: auth-keeper slack read <channel> [limit]}"
                    local limit="${3:-20}"

                    # Resolve channel name to ID if needed
                    local channel_id="$channel"
                    if [[ ! "$channel" =~ ^[CDG] ]]; then
                        local ch_name="${channel#\#}"
                        local ch_list
                        ch_list=$(_ak_slack_user_api "conversations.list" -d '{"types":"public_channel,private_channel","limit":200}')
                        channel_id=$(echo "$ch_list" | jq -r --arg n "$ch_name" '.channels[] | select(.name == $n) | .id')
                        if [[ -z "$channel_id" ]]; then
                            echo "Error: Channel not found: $channel" >&2
                            return 1
                        fi
                    fi

                    local response
                    response=$(_ak_slack_user_api "conversations.history" -d "{\"channel\":\"$channel_id\",\"limit\":$limit}")

                    if echo "$response" | jq -e '.ok' &>/dev/null && [[ $(echo "$response" | jq -r '.ok') == "true" ]]; then
                        echo "Recent messages in $channel:"
                        echo ""
                        echo "$response" | jq -r '.messages | reverse | .[] | "[\(.ts | tonumber | strftime("%m-%d %H:%M"))] \(.user // "bot"): \(.text | .[0:100])"'
                    else
                        echo "Error: $(echo "$response" | jq -r '.error // "Unknown error"')" >&2
                    fi
                    ;;
                "send"|"s")
                    local channel="${2:?Usage: auth-keeper slack send <channel> <message>}"
                    shift 2
                    local message="$*"

                    if [[ -z "$message" ]]; then
                        echo "Usage: auth-keeper slack send <channel> <message>" >&2
                        return 1
                    fi

                    # Resolve channel name to ID if needed
                    local channel_id="$channel"
                    if [[ ! "$channel" =~ ^[CDG] ]]; then
                        local ch_name="${channel#\#}"
                        local ch_list
                        ch_list=$(_ak_slack_api "conversations.list" -d '{"types":"public_channel,private_channel","limit":200}')
                        channel_id=$(echo "$ch_list" | jq -r --arg n "$ch_name" '.channels[] | select(.name == $n) | .id')
                        if [[ -z "$channel_id" ]]; then
                            echo "Error: Channel not found: $channel" >&2
                            return 1
                        fi
                    fi

                    local response
                    response=$(_ak_slack_api "chat.postMessage" -d "$(jq -n --arg ch "$channel_id" --arg txt "$message" '{channel:$ch,text:$txt}')")

                    if echo "$response" | jq -e '.ok' &>/dev/null && [[ $(echo "$response" | jq -r '.ok') == "true" ]]; then
                        local ts
                        ts=$(echo "$response" | jq -r '.ts')
                        echo "Message sent to $channel"
                        echo "  Timestamp: $ts"
                    else
                        echo "Error: $(echo "$response" | jq -r '.error // "Unknown error"')" >&2
                    fi
                    ;;
                "auth"|"test")
                    local response
                    response=$(_ak_slack_api "auth.test")

                    if echo "$response" | jq -e '.ok' &>/dev/null && [[ $(echo "$response" | jq -r '.ok') == "true" ]]; then
                        echo "Slack authentication successful!"
                        echo "  Team: $(echo "$response" | jq -r '.team')"
                        echo "  User: $(echo "$response" | jq -r '.user')"
                        echo "  Bot ID: $(echo "$response" | jq -r '.bot_id // "N/A"')"
                    else
                        echo "Error: $(echo "$response" | jq -r '.error // "Unknown error"')" >&2
                    fi
                    ;;
                "-h"|"--help")
                    cat <<'EOF'
auth-keeper slack - Slack API access

Usage:
  auth-keeper slack                    Show recent activity
  auth-keeper slack channels           List channels
  auth-keeper slack unread             Show unread counts (requires user token)
  auth-keeper slack read <ch> [n]      Read last n messages (requires user token)
  auth-keeper slack send <ch> <msg>    Send message to channel
  auth-keeper slack auth               Test authentication
  auth-keeper slack -h                 Show this help

Channel formats: #general, general, C0123456789

Token Types:
  Bot token (slack-bot-token):   Used for send, channels, auth
  User token (slack-user-token): Required for read, unread

To get a user token:
  1. Go to api.slack.com/apps → Your app → OAuth & Permissions
  2. Add User Token Scopes: channels:history, channels:read, groups:history,
     groups:read, im:history, im:read, mpim:history, mpim:read
  3. Reinstall app to workspace
  4. Copy User OAuth Token (xoxp-...)
  5. Store in BWS: bws secret edit slack-user-token -v "xoxp-..."

Examples:
  auth-keeper slack channels
  auth-keeper slack unread
  auth-keeper slack read #general 10
  auth-keeper slack send #general "Build complete!"
EOF
                    ;;
                *)
                    echo "Unknown slack command: $1 (try: auth-keeper slack -h)" >&2
                    return 1
                    ;;
            esac
            ;;

        telegram|tg)
            shift
            case "${1:-}" in
                ""|"updates")
                    local limit="${2:-10}"
                    local response
                    response=$(_ak_telegram_api "getUpdates" -d "{\"limit\":$limit}")

                    if echo "$response" | jq -e '.ok' &>/dev/null && [[ $(echo "$response" | jq -r '.ok') == "true" ]]; then
                        local count
                        count=$(echo "$response" | jq '.result | length')

                        if [[ "$count" == "0" ]]; then
                            echo "No recent messages to your bot."
                            echo "Send a message to your bot to see it here."
                        else
                            echo "Recent updates ($count):"
                            echo ""
                            echo "$response" | jq -r '.result[] | .message | select(.) |
                                "[\(.date | strftime("%m-%d %H:%M"))] \(.chat.title // .chat.first_name // .chat.id) (\(.chat.type))\n  From: \(.from.first_name // "Unknown")\n  Message: \(.text // "[non-text]" | .[0:80])\n  Chat ID: \(.chat.id)\n"'
                        fi
                    else
                        echo "Error: $(echo "$response" | jq -r '.description // "Unknown error"')" >&2
                    fi
                    ;;
                "send"|"s")
                    local chat="${2:-}"
                    shift 2 2>/dev/null || true
                    local message="$*"

                    # Use default chat if "me" or empty
                    if [[ -z "$chat" || "$chat" == "me" ]]; then
                        chat=$(_ak_telegram_get_chat) || return 1
                    fi

                    if [[ -z "$message" ]]; then
                        echo "Usage: auth-keeper telegram send [chat] <message>" >&2
                        return 1
                    fi

                    local response
                    response=$(_ak_telegram_api "sendMessage" -d "$(jq -n --arg ch "$chat" --arg txt "$message" '{chat_id:$ch,text:$txt}')")

                    if echo "$response" | jq -e '.ok' &>/dev/null && [[ $(echo "$response" | jq -r '.ok') == "true" ]]; then
                        local msg_id
                        msg_id=$(echo "$response" | jq -r '.result.message_id')
                        echo "Message sent!"
                        echo "  Chat: $chat"
                        echo "  Message ID: $msg_id"
                    else
                        echo "Error: $(echo "$response" | jq -r '.description // "Unknown error"')" >&2
                    fi
                    ;;
                "auth"|"me")
                    local response
                    response=$(_ak_telegram_api "getMe")

                    if echo "$response" | jq -e '.ok' &>/dev/null && [[ $(echo "$response" | jq -r '.ok') == "true" ]]; then
                        echo "Bot authentication successful!"
                        echo "  Name: $(echo "$response" | jq -r '.result.first_name')"
                        echo "  Username: @$(echo "$response" | jq -r '.result.username')"
                        echo "  Bot ID: $(echo "$response" | jq -r '.result.id')"
                    else
                        echo "Error: $(echo "$response" | jq -r '.description // "Unknown error"')" >&2
                    fi
                    ;;
                "-h"|"--help")
                    cat <<'EOF'
auth-keeper telegram - Telegram Bot API access

Usage:
  auth-keeper telegram                 Get recent updates
  auth-keeper telegram updates [n]     Get last n updates (default: 10)
  auth-keeper telegram send [chat] <msg>  Send message (default: your chat)
  auth-keeper telegram auth            Test bot token
  auth-keeper telegram -h              Show this help

Chat formats: numeric chat ID, or "me" for default chat

Examples:
  auth-keeper telegram updates
  auth-keeper telegram send "Hello from CLI!"
  auth-keeper telegram send 123456789 "Direct message"
EOF
                    ;;
                *)
                    echo "Unknown telegram command: $1 (try: auth-keeper telegram -h)" >&2
                    return 1
                    ;;
            esac
            ;;

        signal|sig)
            shift
            case "${1:-}" in
                ""|"receive"|"messages")
                    local phone
                    phone=$(_ak_signal_get_phone) || return 1

                    local response
                    response=$(_ak_signal_api "/v1/receive/$phone")

                    if [[ -n "$response" && "$response" != "null" ]]; then
                        local count
                        count=$(echo "$response" | jq 'length' 2>/dev/null || echo "0")

                        if [[ "$count" == "0" || -z "$count" ]]; then
                            echo "No new messages."
                        else
                            echo "Messages ($count):"
                            echo ""
                            echo "$response" | jq -r '.[] | select(.envelope.dataMessage) |
                                "[\(.envelope.timestamp / 1000 | strftime("%m-%d %H:%M"))] \(.envelope.sourceName // .envelope.sourceNumber // "Unknown")\n  \(.envelope.dataMessage.message // "[attachment]")\n"' 2>/dev/null
                        fi
                    else
                        echo "No new messages."
                    fi
                    ;;
                "send"|"s")
                    local phone
                    phone=$(_ak_signal_get_phone) || return 1

                    local recipient message
                    # Check if first arg looks like a phone number
                    if [[ "${2:-}" =~ ^\+[0-9] ]]; then
                        recipient="$2"
                        shift 2 2>/dev/null || true
                        message="$*"
                    else
                        # No recipient, send to self
                        recipient="$phone"
                        shift 1 2>/dev/null || true
                        message="$*"
                    fi

                    if [[ -z "$message" ]]; then
                        echo "Usage: auth-keeper signal send [+recipient] <message>" >&2
                        return 1
                    fi

                    local response
                    response=$(_ak_signal_api "/v1/send" -X POST \
                        -H "Content-Type: application/json" \
                        -d "$(jq -n --arg msg "$message" --arg num "$phone" --arg rec "$recipient" \
                            '{message:$msg,number:$num,recipients:[$rec]}')")

                    if echo "$response" | jq -e '.timestamp' &>/dev/null; then
                        echo "Message sent!"
                        echo "  To: $recipient"
                        echo "  Timestamp: $(echo "$response" | jq -r '.timestamp')"
                    else
                        echo "Error: $(echo "$response" | jq -r '.error // "Unknown error"')" >&2
                    fi
                    ;;
                "link")
                    echo "Generating QR code for device linking..."
                    echo ""
                    echo "1. Open Signal on your phone"
                    echo "2. Go to Settings > Linked Devices"
                    echo "3. Tap 'Link New Device'"
                    echo "4. Scan the QR code"
                    echo ""

                    # Get QR code URI and display as ASCII
                    _ak_signal_api "/v1/qrcodelink?device_name=curu-cli" -o /tmp/signal-qr.png
                    if command -v zbarimg &>/dev/null; then
                        local uri
                        uri=$(zbarimg -q /tmp/signal-qr.png 2>/dev/null | sed 's/QR-Code://')
                        if command -v qrencode &>/dev/null; then
                            qrencode -t UTF8 -m 0 "$uri"
                        else
                            echo "QR saved to /tmp/signal-qr.png"
                            echo "Install qrencode for terminal display: nix-shell -p qrencode"
                        fi
                    else
                        echo "QR saved to /tmp/signal-qr.png"
                        echo "Install zbar for terminal display: nix-shell -p zbar"
                    fi
                    ;;
                "auth"|"status")
                    if ! _ak_signal_api_running; then
                        echo "Signal API not running. Start with:"
                        echo "  docker start signal-cli-rest-api"
                        return 1
                    fi

                    local about accounts
                    about=$(_ak_signal_api "/v1/about")
                    accounts=$(_ak_signal_api "/v1/accounts")

                    echo "Signal REST API:"
                    echo "  Version: $(echo "$about" | jq -r '.version // "unknown"')"
                    echo "  Mode: $(echo "$about" | jq -r '.mode // "unknown"')"
                    echo ""
                    echo "Linked accounts:"
                    if [[ "$accounts" == "[]" ]]; then
                        echo "  None (run: auth-keeper signal link)"
                    else
                        echo "$accounts" | jq -r '.[] | "  \(.)"'
                    fi
                    ;;
                "-h"|"--help")
                    cat <<'EOF'
auth-keeper signal - Signal REST API access (via Docker)

Usage:
  auth-keeper signal                   Receive messages
  auth-keeper signal send [to] <msg>   Send message (default: self)
  auth-keeper signal link              Link device via QR code
  auth-keeper signal auth              Check API status
  auth-keeper signal -h                Show this help

Recipient formats: +1234567890, or "me" for self

Examples:
  auth-keeper signal
  auth-keeper signal send "Note to self"
  auth-keeper signal send +15551234567 "Hello!"
  auth-keeper signal link
EOF
                    ;;
                *)
                    echo "Unknown signal command: $1 (try: auth-keeper signal -h)" >&2
                    return 1
                    ;;
            esac
            ;;

        sdp|SDP)
            # Zone awareness: SDP is work-only
            if [[ "${ZONE:-}" != "work" ]]; then
                echo "⚠️  SDP is a work tool (zone: ${ZONE:-unset}, expected: work)" >&2
            fi
            shift
            case "${1:-}" in
                ""|"my"|"assigned")
                    # List my assigned tickets
                    local input_data
                    input_data=$(jq -n --arg email "$_ak_sdp_user" '{
                        list_info: {
                            row_count: 50,
                            sort_field: "due_by_time",
                            sort_order: "asc",
                            search_criteria: [
                                {field: "technician.email_id", condition: "is", value: $email},
                                {field: "status.name", condition: "is not", values: ["Closed", "Resolved"]}
                            ]
                        }
                    }')

                    local response
                    response=$(_ak_sdp_api GET "/api/v3/requests" --data-urlencode "input_data=$input_data")

                    if echo "$response" | jq -e '.requests' &>/dev/null; then
                        local count
                        count=$(echo "$response" | jq '.requests | length')
                        echo "My assigned tickets ($count):"
                        echo ""
                        echo "$response" | jq -r '.requests[] | "  #\(.id) | \(.subject | .[0:50]) | \(.status.name) | Due: \(.due_by_time // "N/A")"'
                    else
                        echo "Error: $(echo "$response" | jq -r '.response_status[0].messages[0].message // "Unknown error"')" >&2
                    fi
                    ;;
                "overdue")
                    local now_ms
                    now_ms=$(($(date +%s) * 1000))

                    local input_data
                    input_data=$(jq -n --arg email "$_ak_sdp_user" --argjson now "$now_ms" '{
                        list_info: {
                            row_count: 50,
                            sort_field: "due_by_time",
                            sort_order: "asc",
                            search_criteria: [
                                {field: "technician.email_id", condition: "is", value: $email},
                                {field: "due_by_time", condition: "less than", value: ($now | tostring)},
                                {field: "status.name", condition: "is not", values: ["Closed", "Resolved"]}
                            ]
                        }
                    }')

                    local response
                    response=$(_ak_sdp_api GET "/api/v3/requests" --data-urlencode "input_data=$input_data")

                    if echo "$response" | jq -e '.requests' &>/dev/null; then
                        local count
                        count=$(echo "$response" | jq '.requests | length')
                        if [[ "$count" == "0" ]]; then
                            echo "No overdue tickets!"
                        else
                            echo "Overdue tickets ($count):"
                            echo ""
                            echo "$response" | jq -r '.requests[] | "  #\(.id) | \(.subject | .[0:50]) | Due: \(.due_by_time)"'
                        fi
                    else
                        echo "Error: $(echo "$response" | jq -r '.response_status[0].messages[0].message // "Unknown error"')" >&2
                    fi
                    ;;
                "note")
                    local ticket_id="${2:?Usage: auth-keeper sdp note <ticket_id> <message>}"
                    shift 2
                    local message="$*"

                    if [[ -z "$message" ]]; then
                        echo "Usage: auth-keeper sdp note <ticket_id> <message>" >&2
                        return 1
                    fi

                    local input_data
                    input_data=$(jq -n --arg msg "$message" '{
                        request_note: {
                            description: $msg,
                            show_to_requester: false,
                            notify_technician: false
                        }
                    }')

                    local response
                    response=$(_ak_sdp_api POST "/api/v3/requests/$ticket_id/notes" -d "input_data=$input_data")

                    if echo "$response" | jq -e '.request_note' &>/dev/null; then
                        local note_id
                        note_id=$(echo "$response" | jq -r '.request_note.id')
                        echo "Note added to ticket #$ticket_id"
                        echo "  Note ID: $note_id"
                    else
                        echo "Error: $(echo "$response" | jq -r '.response_status[0].messages[0].message // "Unknown error"')" >&2
                    fi
                    ;;
                "reply")
                    local ticket_id="${2:?Usage: auth-keeper sdp reply <ticket_id> <message>}"
                    shift 2
                    local message="$*"

                    if [[ -z "$message" ]]; then
                        echo "Usage: auth-keeper sdp reply <ticket_id> <message>" >&2
                        return 1
                    fi

                    local input_data
                    input_data=$(jq -n --arg msg "$message" '{
                        reply: {
                            description: $msg
                        }
                    }')

                    local response
                    response=$(_ak_sdp_api POST "/api/v3/requests/$ticket_id/reply" -d "input_data=$input_data")

                    if echo "$response" | jq -e '.response_status[0].status_code' &>/dev/null; then
                        local status_code
                        status_code=$(echo "$response" | jq -r '.response_status[0].status_code')
                        if [[ "$status_code" == "2000" ]]; then
                            echo "Reply sent to ticket #$ticket_id"
                        else
                            echo "Error: $(echo "$response" | jq -r '.response_status[0].messages[0].message // "Unknown error"')" >&2
                        fi
                    else
                        echo "Error: Unexpected response" >&2
                    fi
                    ;;
                "get"|"show")
                    local ticket_id="${2:?Usage: auth-keeper sdp get <ticket_id>}"

                    local response
                    response=$(_ak_sdp_api GET "/api/v3/requests/$ticket_id")

                    if echo "$response" | jq -e '.request' &>/dev/null; then
                        echo "$response" | jq -r '.request | "Ticket #\(.id)\n  Subject: \(.subject)\n  Status: \(.status.name)\n  Priority: \(.priority.name // "N/A")\n  Requester: \(.requester.name) <\(.requester.email_id)>\n  Technician: \(.technician.name // "Unassigned")\n  Due: \(.due_by_time // "N/A")\n  Created: \(.created_time.display_value)\n\nDescription:\n\(.description // "No description")"'
                    else
                        echo "Error: $(echo "$response" | jq -r '.response_status[0].messages[0].message // "Unknown error"')" >&2
                    fi
                    ;;
                "auth"|"test")
                    echo "SDP Configuration (OAuth 2.0):"
                    echo "  Base URL: $(_ak_bws_get 'sdp-base-url')"
                    echo "  User: $_ak_sdp_user"
                    echo "  Client ID: $(_ak_bws_get 'sdp-client-id' | head -c 20)..."
                    echo ""
                    echo "Fetching access token..."
                    _ak_sdp_ensure_token || return 1
                    echo "  Token: ${_ak_sdp_token:0:20}... (valid ~1hr)"
                    echo ""
                    echo "Testing API connection..."

                    _ak_sdp_get_creds || return 1
                    local response
                    response=$(_ak_sdp_api GET "/api/v3/requests" --data-urlencode 'input_data={"list_info":{"row_count":1}}')

                    # response_status is an array in SDP Cloud API
                    if echo "$response" | jq -e '.response_status[0].status_code' &>/dev/null; then
                        local status_code
                        status_code=$(echo "$response" | jq -r '.response_status[0].status_code')
                        if [[ "$status_code" == "2000" ]]; then
                            local count
                            count=$(echo "$response" | jq -r '.requests | length')
                            echo "Connection successful! (found $count tickets)"
                        else
                            echo "Error: $(echo "$response" | jq -r '.response_status[0].messages[0].message // "Unknown error"')" >&2
                        fi
                    else
                        echo "API response: $response" >&2
                        echo "Connection failed - check credentials" >&2
                    fi
                    ;;
                "-h"|"--help")
                    cat <<'EOF'
auth-keeper sdp - ServiceDesk Plus API access

Usage:
  auth-keeper sdp                    List my assigned tickets
  auth-keeper sdp overdue            List overdue tickets
  auth-keeper sdp get <id>           Get ticket details
  auth-keeper sdp note <id> <msg>    Add internal note
  auth-keeper sdp reply <id> <msg>   Send reply to requester
  auth-keeper sdp auth               Test API connection
  auth-keeper sdp -h                 Show this help

Examples:
  auth-keeper sdp
  auth-keeper sdp overdue
  auth-keeper sdp get 12345
  auth-keeper sdp note 12345 "Investigated - DNS issue on prod-web-03"
  auth-keeper sdp reply 12345 "Issue resolved. DNS cache cleared."
EOF
                    ;;
                *)
                    echo "Unknown sdp command: $1 (try: auth-keeper sdp -h)" >&2
                    return 1
                    ;;
            esac
            ;;

        refresh|r)
            case "${2:-}" in
                aws|aws-sso)
                    _ak_aws_refresh "${3:-}"
                    ;;
                azure|az)
                    _ak_azure_refresh
                    ;;
                google)
                    _ak_google_get_access_token >/dev/null && echo "Google token refreshed"
                    ;;
                all)
                    _ak_aws_refresh
                    _ak_azure_refresh
                    _ak_google_get_access_token >/dev/null && echo "Google token refreshed"
                    ;;
                *)
                    echo "Usage: auth-keeper refresh [aws|azure|google|all]"
                    ;;
            esac
            ;;

        help|h|--help|-h)
            cat <<'EOF'
auth-keeper - Unified authentication and service access

Usage: auth-keeper [command]

Commands:
  status              Show status of all services
  ms365 [cmd]         MS365 PowerShell access (service principal)
  google [cmd]        Google API access (OAuth2)
  slack [cmd]         Slack API access (bot token)
  telegram [cmd]      Telegram Bot API access
  signal [cmd]        Signal REST API access (Docker)
  sdp [cmd]           ServiceDesk Plus ticket management
  refresh [service]   Force token refresh
  help                Show this help

Service Access:
  auth-keeper ms365                    Interactive MS365 PowerShell
  auth-keeper ms365 "Get-MgUser..."    Run MS365 command
  auth-keeper google mail              List Gmail
  auth-keeper google calendar          List Google Calendar
  auth-keeper slack channels           List Slack channels
  auth-keeper signal send "msg"        Send Signal message
  auth-keeper slack send #ch "msg"     Send Slack message
  auth-keeper telegram updates         Get Telegram updates
  auth-keeper telegram send "msg"      Send Telegram message
  auth-keeper sdp                      List my SDP tickets
  auth-keeper sdp note 12345 "msg"     Add note to ticket

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
if [[ -n "${ZSH_VERSION:-}" ]] && command -v compdef &>/dev/null; then
    _auth_keeper_zsh() {
        local -a commands
        commands=(
            'status:Show status of all services'
            'ms365:MS365 PowerShell access'
            'google:Google API access'
            'slack:Slack API access'
            'telegram:Telegram Bot API access'
            'signal:Signal REST API access'
            'sdp:ServiceDesk Plus ticket management'
            'refresh:Force token refresh'
            'help:Show help'
        )
        _describe 'command' commands
    }
    compdef _auth_keeper_zsh auth-keeper 2>/dev/null
elif [[ -n "${BASH_VERSION:-}" ]]; then
    _auth_keeper_comp() {
        local cur="${COMP_WORDS[COMP_CWORD]}"
        case "${COMP_WORDS[1]:-}" in
            refresh) mapfile -t COMPREPLY < <(compgen -W "aws azure google all" -- "$cur") ;;
            google) mapfile -t COMPREPLY < <(compgen -W "mail calendar --auth --token --help" -- "$cur") ;;
            ms365) mapfile -t COMPREPLY < <(compgen -W "--interactive --help" -- "$cur") ;;
            slack) mapfile -t COMPREPLY < <(compgen -W "channels unread read send auth --help" -- "$cur") ;;
            telegram) mapfile -t COMPREPLY < <(compgen -W "updates send auth --help" -- "$cur") ;;
            signal) mapfile -t COMPREPLY < <(compgen -W "receive send link auth --help" -- "$cur") ;;
            sdp) mapfile -t COMPREPLY < <(compgen -W "my overdue get note reply auth --help" -- "$cur") ;;
            *) mapfile -t COMPREPLY < <(compgen -W "status ms365 google slack telegram signal sdp refresh help" -- "$cur") ;;
        esac
    }
    complete -F _auth_keeper_comp auth-keeper
fi

# ============================================================================
# Quick Inbox (Signal as primary)
# ============================================================================

# Quick capture to Signal inbox
inbox() {
    local message="$*"

    # If no args, read from stdin (for piping)
    if [[ -z "$message" ]]; then
        if [[ ! -t 0 ]]; then
            message=$(cat)
        else
            echo "Usage: inbox <message>" >&2
            echo "       echo 'text' | inbox" >&2
            return 1
        fi
    fi

    auth-keeper signal send "$message"
}

# Alias for even quicker access
i() { inbox "$@"; }

# Send command output to inbox
# Usage: inbox-run ls -la
inbox-run() {
    local output
    output=$("$@" 2>&1)
    local status=$?
    inbox "$ $*
---
$output
---
Exit: $status"
    return $status
}

