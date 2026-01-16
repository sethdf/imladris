#!/usr/bin/env bash
# ocal - MS365 Outlook Calendar CLI (work context only)
# Usage: ocal [today|tomorrow|week|N] [--json]
#
# Examples:
#   ocal           # Today's events
#   ocal today     # Today's events
#   ocal tomorrow  # Tomorrow's events
#   ocal week      # Next 7 days
#   ocal 3         # Next 3 days
#   ocal --json    # Output as JSON
#
# Requires: CONTEXT=work (set via direnv)

set -euo pipefail

# Context check - MS365 is work only
if [[ "${CONTEXT:-}" != "work" && "${1:-}" != "--auth" && "${1:-}" != "-a" && "${1:-}" != "--help" && "${1:-}" != "-h" ]]; then
    echo -e "\033[0;31mError: ocal requires work context\033[0m" >&2
    echo "Set CONTEXT=work or cd to a work directory" >&2
    exit 1
fi

# Config
CLIENT_ID="a7e5374a-7e56-452b-b9da-655c78bc4121"
TENANT_ID="99cc3795-3b94-4c8f-a292-8c4c153771a5"
GRAPH_URL="https://graph.microsoft.com/v1.0"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

_ocal_get_token() {
    secret-tool lookup service imladris-graph type access-token 2>/dev/null
}

_ocal_get_refresh_token() {
    secret-tool lookup service imladris-graph type refresh-token 2>/dev/null
}

_ocal_get_expiry() {
    secret-tool lookup service imladris-graph type expiry 2>/dev/null || echo "0"
}

_ocal_store_tokens() {
    local access_token="$1"
    local refresh_token="$2"
    local expires_in="$3"
    local expiry_time=$(($(date +%s) + expires_in))

    echo -n "$access_token" | secret-tool store --label="graph-calendar-access-token" service imladris-graph type access-token
    echo -n "$refresh_token" | secret-tool store --label="graph-calendar-refresh-token" service imladris-graph type refresh-token
    echo -n "$expiry_time" | secret-tool store --label="graph-calendar-expiry" service imladris-graph type expiry
}

_ocal_refresh_token() {
    local refresh_token
    refresh_token=$(_ocal_get_refresh_token)

    if [[ -z "$refresh_token" ]]; then
        echo -e "${RED}Error: No refresh token found. Run 'ocal --auth' to authenticate.${NC}" >&2
        return 1
    fi

    local response
    response=$(curl -s -X POST "https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0/token" \
        -d "client_id=$CLIENT_ID" \
        -d "grant_type=refresh_token" \
        -d "refresh_token=$refresh_token" \
        -d "scope=https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Calendars.ReadWrite offline_access")

    if echo "$response" | jq -e '.access_token' &>/dev/null; then
        local access_token expires_in new_refresh_token
        access_token=$(echo "$response" | jq -r '.access_token')
        expires_in=$(echo "$response" | jq -r '.expires_in')
        new_refresh_token=$(echo "$response" | jq -r '.refresh_token // empty')

        # Use new refresh token if provided, otherwise keep old one
        [[ -z "$new_refresh_token" ]] && new_refresh_token="$refresh_token"

        _ocal_store_tokens "$access_token" "$new_refresh_token" "$expires_in"
        echo "$access_token"
    else
        echo -e "${RED}Error refreshing token: $(echo "$response" | jq -r '.error_description // .error')${NC}" >&2
        return 1
    fi
}

_ocal_ensure_token() {
    local expiry access_token now
    expiry=$(_ocal_get_expiry)
    now=$(date +%s)

    # Refresh if expiring in less than 5 minutes
    if [[ $((expiry - now)) -lt 300 ]]; then
        _ocal_refresh_token
    else
        _ocal_get_token
    fi
}

_ocal_auth() {
    local scope="https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Calendars.ReadWrite offline_access"

    # Request device code
    local device_response
    device_response=$(curl -s -X POST "https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0/devicecode" \
        -d "client_id=$CLIENT_ID" \
        -d "scope=$scope")

    local user_code device_code message
    user_code=$(echo "$device_response" | jq -r '.user_code')
    device_code=$(echo "$device_response" | jq -r '.device_code')
    message=$(echo "$device_response" | jq -r '.message')

    echo -e "${CYAN}$message${NC}"

    # Poll for token
    for i in {1..60}; do
        local response
        response=$(curl -s -X POST "https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0/token" \
            -d "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
            -d "client_id=$CLIENT_ID" \
            -d "device_code=$device_code")

        if echo "$response" | jq -e '.access_token' &>/dev/null; then
            local access_token refresh_token expires_in
            access_token=$(echo "$response" | jq -r '.access_token')
            refresh_token=$(echo "$response" | jq -r '.refresh_token')
            expires_in=$(echo "$response" | jq -r '.expires_in')

            _ocal_store_tokens "$access_token" "$refresh_token" "$expires_in"
            echo -e "${GREEN}✓ Authentication successful${NC}"
            return 0
        elif echo "$response" | jq -e '.error == "authorization_pending"' &>/dev/null; then
            sleep 5
        else
            echo -e "${RED}Error: $(echo "$response" | jq -r '.error_description // .error')${NC}" >&2
            return 1
        fi
    done

    echo -e "${RED}Error: Authentication timed out${NC}" >&2
    return 1
}

_ocal_format_event() {
    local event="$1"
    local subject start_time end_time location is_all_day organizer

    subject=$(echo "$event" | jq -r '.subject // "No subject"')
    is_all_day=$(echo "$event" | jq -r '.isAllDay')
    location=$(echo "$event" | jq -r '.location.displayName // empty')
    organizer=$(echo "$event" | jq -r '.organizer.emailAddress.name // empty')

    if [[ "$is_all_day" == "true" ]]; then
        start_time="All day"
        end_time=""
    else
        # Parse ISO datetime (API returns UTC) and convert to local timezone
        local start_iso end_iso start_tz end_tz
        start_iso=$(echo "$event" | jq -r '.start.dateTime')
        end_iso=$(echo "$event" | jq -r '.end.dateTime')
        start_tz=$(echo "$event" | jq -r '.start.timeZone // "UTC"')
        end_tz=$(echo "$event" | jq -r '.end.timeZone // "UTC"')

        # Append timezone for proper conversion (handles both UTC and named timezones)
        if [[ "$start_tz" == "UTC" ]]; then
            start_time=$(TZ=America/Denver date -d "${start_iso}Z" "+%H:%M" 2>/dev/null || echo "$start_iso")
            end_time=$(TZ=America/Denver date -d "${end_iso}Z" "+%H:%M" 2>/dev/null || echo "$end_iso")
        else
            # If timezone is already specified (e.g., Mountain Standard Time), use as-is
            start_time=$(date -d "$start_iso" "+%H:%M" 2>/dev/null || echo "$start_iso")
            end_time=$(date -d "$end_iso" "+%H:%M" 2>/dev/null || echo "$end_iso")
        fi
    fi

    # Format output
    if [[ "$is_all_day" == "true" ]]; then
        echo -e "  ${YELLOW}All day${NC}  ${GREEN}$subject${NC}"
    else
        echo -e "  ${CYAN}${start_time}-${end_time}${NC}  ${GREEN}$subject${NC}"
    fi

    [[ -n "$location" ]] && echo -e "           📍 $location"
    [[ -n "$organizer" ]] && echo -e "           👤 $organizer"
}

_ocal_list() {
    local days="${1:-1}"
    local json_output="${2:-false}"

    local access_token
    access_token=$(_ocal_ensure_token) || return 1

    local start_time end_time
    start_time=$(date -u +"%Y-%m-%dT00:00:00Z")
    end_time=$(date -u -d "+${days} days" +"%Y-%m-%dT23:59:59Z")

    local response
    response=$(curl -s -H "Authorization: Bearer $access_token" \
        "$GRAPH_URL/me/calendarView?startDateTime=$start_time&endDateTime=$end_time&\$orderby=start/dateTime&\$top=50")

    if echo "$response" | jq -e '.error' &>/dev/null; then
        echo -e "${RED}Error: $(echo "$response" | jq -r '.error.message')${NC}" >&2
        return 1
    fi

    if [[ "$json_output" == "true" ]]; then
        echo "$response" | jq '.value'
        return 0
    fi

    local events
    events=$(echo "$response" | jq -r '.value')
    local count
    count=$(echo "$events" | jq 'length')

    if [[ "$count" -eq 0 ]]; then
        echo -e "${YELLOW}No events found${NC}"
        return 0
    fi

    local current_date=""
    echo "$events" | jq -c '.[]' | while read -r event; do
        local event_date
        event_date=$(echo "$event" | jq -r '.start.dateTime' | cut -d'T' -f1)

        # Print date header if changed
        if [[ "$event_date" != "$current_date" ]]; then
            current_date="$event_date"
            local formatted_date
            formatted_date=$(date -d "$event_date" "+%A, %B %d" 2>/dev/null || echo "$event_date")
            echo ""
            echo -e "${BLUE}━━━ $formatted_date ━━━${NC}"
        fi

        _ocal_format_event "$event"
    done
    echo ""
}

_ocal_status() {
    local expiry access_token now remaining
    expiry=$(_ocal_get_expiry)
    now=$(date +%s)
    remaining=$((expiry - now))

    if [[ $remaining -gt 0 ]]; then
        local hours=$((remaining / 3600))
        local mins=$(((remaining % 3600) / 60))
        echo -e "${GREEN}✓ Token valid${NC} (expires in ${hours}h ${mins}m)"
    else
        echo -e "${YELLOW}⚠ Token expired${NC} - will refresh on next request"
    fi
}

# Main
case "${1:-today}" in
    --auth|-a)
        _ocal_auth
        ;;
    --status|-s)
        _ocal_status
        ;;
    --json|-j)
        _ocal_list "${2:-1}" "true"
        ;;
    today|t)
        _ocal_list 1
        ;;
    tomorrow|tm)
        # Shift start to tomorrow
        _ocal_list 2 | tail -n +2
        ;;
    week|w)
        _ocal_list 7
        ;;
    [0-9]*)
        _ocal_list "$1"
        ;;
    --help|-h|help)
        echo "Usage: ocal [command]"
        echo ""
        echo "Commands:"
        echo "  today, t       Show today's events (default)"
        echo "  tomorrow, tm   Show tomorrow's events"
        echo "  week, w        Show next 7 days"
        echo "  N              Show next N days (e.g., 'ocal 3')"
        echo "  --json, -j     Output as JSON"
        echo "  --auth, -a     Re-authenticate"
        echo "  --status, -s   Show token status"
        echo "  --help, -h     Show this help"
        ;;
    *)
        _ocal_list 1
        ;;
esac
