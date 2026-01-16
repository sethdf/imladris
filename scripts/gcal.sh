#!/usr/bin/env bash
# gcal - Google Calendar CLI (home context only)
# Usage: gcal [today|tomorrow|week|N] [--json]
#
# Examples:
#   gcal           # Today's events
#   gcal today     # Today's events
#   gcal tomorrow  # Tomorrow's events
#   gcal week      # Next 7 days
#   gcal 3         # Next 3 days
#   gcal --json    # Output as JSON
#
# Requires: CONTEXT=home (set via direnv)
# Setup: gcal --auth (requires Google Cloud OAuth credentials)

set -euo pipefail

# Context check - Google personal is home only
if [[ "${CONTEXT:-}" != "home" && "${1:-}" != "--auth" && "${1:-}" != "-a" && "${1:-}" != "--help" && "${1:-}" != "-h" && "${1:-}" != "--setup" ]]; then
    echo -e "\033[0;31mError: gcal requires home context\033[0m" >&2
    echo "Set CONTEXT=home or cd to a home directory" >&2
    exit 1
fi

# Config - Set these after creating OAuth credentials in Google Cloud Console
# 1. Go to https://console.cloud.google.com/
# 2. Create a project (or use existing)
# 3. Enable Google Calendar API
# 4. Create OAuth 2.0 credentials (Desktop app)
# 5. Set CLIENT_ID and CLIENT_SECRET below or in keyring
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-$(secret-tool lookup service imladris-google type client-id 2>/dev/null || echo "")}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-$(secret-tool lookup service imladris-google type client-secret 2>/dev/null || echo "")}"
CALENDAR_API="https://www.googleapis.com/calendar/v3"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

_gcal_get_token() {
    secret-tool lookup service imladris-google type access-token 2>/dev/null
}

_gcal_get_refresh_token() {
    secret-tool lookup service imladris-google type refresh-token 2>/dev/null
}

_gcal_get_expiry() {
    secret-tool lookup service imladris-google type expiry 2>/dev/null || echo "0"
}

_gcal_store_tokens() {
    local access_token="$1"
    local refresh_token="$2"
    local expires_in="$3"
    local expiry_time=$(($(date +%s) + expires_in))

    echo -n "$access_token" | secret-tool store --label="google-calendar-access-token" service imladris-google type access-token
    echo -n "$refresh_token" | secret-tool store --label="google-calendar-refresh-token" service imladris-google type refresh-token
    echo -n "$expiry_time" | secret-tool store --label="google-calendar-expiry" service imladris-google type expiry
}

_gcal_refresh_token() {
    local refresh_token
    refresh_token=$(_gcal_get_refresh_token)

    if [[ -z "$refresh_token" ]]; then
        echo -e "${RED}Error: No refresh token found. Run 'gcal --auth' to authenticate.${NC}" >&2
        return 1
    fi

    if [[ -z "$GOOGLE_CLIENT_ID" || -z "$GOOGLE_CLIENT_SECRET" ]]; then
        echo -e "${RED}Error: Google OAuth credentials not configured. Run 'gcal --setup' first.${NC}" >&2
        return 1
    fi

    local response
    response=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
        -d "client_id=$GOOGLE_CLIENT_ID" \
        -d "client_secret=$GOOGLE_CLIENT_SECRET" \
        -d "grant_type=refresh_token" \
        -d "refresh_token=$refresh_token")

    if echo "$response" | jq -e '.access_token' &>/dev/null; then
        local access_token expires_in
        access_token=$(echo "$response" | jq -r '.access_token')
        expires_in=$(echo "$response" | jq -r '.expires_in')

        # Google doesn't always return a new refresh token
        _gcal_store_tokens "$access_token" "$refresh_token" "$expires_in"
        echo "$access_token"
    else
        echo -e "${RED}Error refreshing token: $(echo "$response" | jq -r '.error_description // .error')${NC}" >&2
        return 1
    fi
}

_gcal_ensure_token() {
    local expiry access_token now
    expiry=$(_gcal_get_expiry)
    now=$(date +%s)

    # Refresh if expiring in less than 5 minutes
    if [[ $((expiry - now)) -lt 300 ]]; then
        _gcal_refresh_token
    else
        _gcal_get_token
    fi
}

_gcal_setup() {
    echo -e "${CYAN}Google Calendar Setup${NC}"
    echo ""
    echo "1. Go to https://console.cloud.google.com/"
    echo "2. Create a project (or select existing)"
    echo "3. Go to APIs & Services > Library"
    echo "4. Enable 'Google Calendar API'"
    echo "5. Go to APIs & Services > Credentials"
    echo "6. Create OAuth 2.0 Client ID (Desktop app)"
    echo "7. Copy the Client ID and Client Secret"
    echo ""
    read -rp "Enter Client ID: " client_id
    read -rp "Enter Client Secret: " client_secret

    if [[ -n "$client_id" && -n "$client_secret" ]]; then
        echo -n "$client_id" | secret-tool store --label="google-oauth-client-id" service imladris-google type client-id
        echo -n "$client_secret" | secret-tool store --label="google-oauth-client-secret" service imladris-google type client-secret
        echo -e "${GREEN}✓ Credentials stored. Now run 'gcal --auth' to authenticate.${NC}"
    else
        echo -e "${RED}Error: Both Client ID and Client Secret are required.${NC}" >&2
        return 1
    fi
}

_gcal_auth() {
    if [[ -z "$GOOGLE_CLIENT_ID" || -z "$GOOGLE_CLIENT_SECRET" ]]; then
        echo -e "${RED}Error: Google OAuth credentials not configured. Run 'gcal --setup' first.${NC}" >&2
        return 1
    fi

    local scope="https://www.googleapis.com/auth/calendar.readonly"
    local redirect_uri="urn:ietf:wg:oauth:2.0:oob"

    # Generate auth URL
    local auth_url="https://accounts.google.com/o/oauth2/v2/auth"
    auth_url+="?client_id=$GOOGLE_CLIENT_ID"
    auth_url+="&redirect_uri=$redirect_uri"
    auth_url+="&response_type=code"
    auth_url+="&scope=$scope"
    auth_url+="&access_type=offline"
    auth_url+="&prompt=consent"

    echo -e "${CYAN}Open this URL in your browser:${NC}"
    echo ""
    echo "$auth_url"
    echo ""
    read -rp "Enter the authorization code: " auth_code

    if [[ -z "$auth_code" ]]; then
        echo -e "${RED}Error: No authorization code provided.${NC}" >&2
        return 1
    fi

    # Exchange code for tokens
    local response
    response=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
        -d "client_id=$GOOGLE_CLIENT_ID" \
        -d "client_secret=$GOOGLE_CLIENT_SECRET" \
        -d "code=$auth_code" \
        -d "grant_type=authorization_code" \
        -d "redirect_uri=$redirect_uri")

    if echo "$response" | jq -e '.access_token' &>/dev/null; then
        local access_token refresh_token expires_in
        access_token=$(echo "$response" | jq -r '.access_token')
        refresh_token=$(echo "$response" | jq -r '.refresh_token')
        expires_in=$(echo "$response" | jq -r '.expires_in')

        _gcal_store_tokens "$access_token" "$refresh_token" "$expires_in"
        echo -e "${GREEN}✓ Authentication successful${NC}"
    else
        echo -e "${RED}Error: $(echo "$response" | jq -r '.error_description // .error')${NC}" >&2
        return 1
    fi
}

_gcal_format_event() {
    local event="$1"
    local summary start_time end_time location is_all_day organizer

    summary=$(echo "$event" | jq -r '.summary // "No title"')
    location=$(echo "$event" | jq -r '.location // empty')
    organizer=$(echo "$event" | jq -r '.organizer.displayName // .organizer.email // empty')

    # Check if all-day event (date vs dateTime)
    if echo "$event" | jq -e '.start.date' &>/dev/null; then
        is_all_day="true"
        start_time="All day"
        end_time=""
    else
        is_all_day="false"
        local start_iso end_iso
        start_iso=$(echo "$event" | jq -r '.start.dateTime')
        end_iso=$(echo "$event" | jq -r '.end.dateTime')
        # Google returns times with timezone, convert to local
        start_time=$(date -d "$start_iso" "+%H:%M" 2>/dev/null || echo "$start_iso")
        end_time=$(date -d "$end_iso" "+%H:%M" 2>/dev/null || echo "$end_iso")
    fi

    # Format output
    if [[ "$is_all_day" == "true" ]]; then
        echo -e "  ${YELLOW}All day${NC}  ${GREEN}$summary${NC}"
    else
        echo -e "  ${CYAN}${start_time}-${end_time}${NC}  ${GREEN}$summary${NC}"
    fi

    [[ -n "$location" ]] && echo -e "           📍 $location"
    [[ -n "$organizer" && "$organizer" != "null" ]] && echo -e "           👤 $organizer"
}

_gcal_list() {
    local days="${1:-1}"
    local json_output="${2:-false}"

    local access_token
    access_token=$(_gcal_ensure_token) || return 1

    local start_time end_time
    start_time=$(date -u +"%Y-%m-%dT00:00:00Z")
    end_time=$(date -u -d "+${days} days" +"%Y-%m-%dT23:59:59Z")

    local response
    response=$(curl -s -H "Authorization: Bearer $access_token" \
        "$CALENDAR_API/calendars/primary/events?timeMin=$start_time&timeMax=$end_time&singleEvents=true&orderBy=startTime&maxResults=50")

    if echo "$response" | jq -e '.error' &>/dev/null; then
        echo -e "${RED}Error: $(echo "$response" | jq -r '.error.message')${NC}" >&2
        return 1
    fi

    if [[ "$json_output" == "true" ]]; then
        echo "$response" | jq '.items'
        return 0
    fi

    local events
    events=$(echo "$response" | jq -r '.items // []')
    local count
    count=$(echo "$events" | jq 'length')

    if [[ "$count" -eq 0 ]]; then
        echo -e "${YELLOW}No events found${NC}"
        return 0
    fi

    local current_date=""
    echo "$events" | jq -c '.[]' | while read -r event; do
        local event_date
        # Handle both all-day (date) and timed (dateTime) events
        event_date=$(echo "$event" | jq -r '.start.date // .start.dateTime' | cut -d'T' -f1)

        # Print date header if changed
        if [[ "$event_date" != "$current_date" ]]; then
            current_date="$event_date"
            local formatted_date
            formatted_date=$(date -d "$event_date" "+%A, %B %d" 2>/dev/null || echo "$event_date")
            echo ""
            echo -e "${BLUE}━━━ $formatted_date ━━━${NC}"
        fi

        _gcal_format_event "$event"
    done
    echo ""
}

_gcal_status() {
    local expiry now remaining
    expiry=$(_gcal_get_expiry)
    now=$(date +%s)
    remaining=$((expiry - now))

    if [[ -z "$GOOGLE_CLIENT_ID" ]]; then
        echo -e "${RED}✗ Not configured${NC} - run 'gcal --setup'"
    elif [[ $remaining -gt 0 ]]; then
        local hours=$((remaining / 3600))
        local mins=$(((remaining % 3600) / 60))
        echo -e "${GREEN}✓ Token valid${NC} (expires in ${hours}h ${mins}m)"
    else
        echo -e "${YELLOW}⚠ Token expired${NC} - will refresh on next request"
    fi
}

# Main
case "${1:-today}" in
    --setup|-S)
        _gcal_setup
        ;;
    --auth|-a)
        _gcal_auth
        ;;
    --status|-s)
        _gcal_status
        ;;
    --json|-j)
        _gcal_list "${2:-1}" "true"
        ;;
    today|t)
        _gcal_list 1
        ;;
    tomorrow|tm)
        _gcal_list 2 | tail -n +2
        ;;
    week|w)
        _gcal_list 7
        ;;
    [0-9]*)
        _gcal_list "$1"
        ;;
    --help|-h|help)
        echo "Usage: gcal [command]"
        echo ""
        echo "Commands:"
        echo "  today, t       Show today's events (default)"
        echo "  tomorrow, tm   Show tomorrow's events"
        echo "  week, w        Show next 7 days"
        echo "  N              Show next N days (e.g., 'gcal 3')"
        echo "  --json, -j     Output as JSON"
        echo "  --setup, -S    Configure Google OAuth credentials"
        echo "  --auth, -a     Authenticate with Google"
        echo "  --status, -s   Show token status"
        echo "  --help, -h     Show this help"
        ;;
    *)
        _gcal_list 1
        ;;
esac
