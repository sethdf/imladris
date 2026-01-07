#!/bin/bash
#
# sdp-api - ServiceDesk Plus API helper
#
# Configuration (set via environment or Bitwarden Secrets Manager):
#   SDP_BASE_URL     - Your SDP instance URL (e.g., https://sdp.example.com)
#   SDP_API_KEY      - API technician key
#   SDP_TECHNICIAN_ID - Your technician ID (for filtering assigned tickets)
#
# Usage:
#   sdp-api list                     # List my assigned tickets
#   sdp-api get <id>                 # Get ticket details
#   sdp-api note <id> "<message>"    # Add note to ticket
#   sdp-api status <id> "<status>"   # Update ticket status
#   sdp-api search "<query>"         # Search tickets
#
set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

: "${SDP_BASE_URL:?SDP_BASE_URL not set}"
: "${SDP_API_KEY:?SDP_API_KEY not set}"
: "${SDP_TECHNICIAN_ID:=}"

API_URL="${SDP_BASE_URL}/api/v3"

# =============================================================================
# Helper Functions
# =============================================================================

api_call() {
    local method="$1"
    local endpoint="$2"
    local data="${3:-}"

    local args=(
        -s
        -X "$method"
        -H "authtoken: ${SDP_API_KEY}"
        -H "Content-Type: application/x-www-form-urlencoded"
    )

    if [[ -n "$data" ]]; then
        args+=(-d "input_data=${data}")
    fi

    curl "${args[@]}" "${API_URL}${endpoint}"
}

format_ticket_list() {
    jq -r '
        .requests[]? |
        [.id, .subject[0:40], .priority.name // "N/A", .status.name // "N/A"] |
        @tsv
    ' | column -t -s $'\t' -N "ID,Subject,Priority,Status"
}

format_ticket_detail() {
    jq -r '
        .request |
        "Ticket: SDP-\(.id)\nSubject: \(.subject)\n\nDescription:\n\(.description // "No description")\n\nPriority: \(.priority.name // "N/A")\nStatus: \(.status.name // "N/A")\nCreated: \(.created_time.display_value // "N/A")\nDue: \(.due_by_time.display_value // "N/A")"
    '
}

# =============================================================================
# Commands
# =============================================================================

cmd_list() {
    local filter=""

    if [[ -n "$SDP_TECHNICIAN_ID" ]]; then
        # Filter by assigned technician
        filter='{"list_info":{"row_count":50,"search_fields":{"technician.id":"'"$SDP_TECHNICIAN_ID"'"}}}'
    else
        # Just get recent open tickets
        filter='{"list_info":{"row_count":50,"filter_by":{"name":"Open"}}}'
    fi

    echo "My Assigned Tickets"
    echo "==================="
    api_call GET "/requests" "$filter" | format_ticket_list
}

cmd_get() {
    local id="$1"
    # Strip "SDP-" prefix if present
    id="${id#SDP-}"

    api_call GET "/requests/${id}"
}

cmd_get_formatted() {
    local id="$1"
    id="${id#SDP-}"

    api_call GET "/requests/${id}" | format_ticket_detail
}

cmd_note() {
    local id="$1"
    local message="$2"
    id="${id#SDP-}"

    local data
    data=$(jq -n --arg msg "$message" '{
        "note": {
            "description": $msg,
            "show_to_requester": false,
            "notify_technician": false
        }
    }')

    api_call POST "/requests/${id}/notes" "$data"
    echo "Note added to SDP-${id}"
}

cmd_status() {
    local id="$1"
    local status="$2"
    id="${id#SDP-}"

    # Map common status names to SDP status
    case "${status,,}" in
        "open"|"new")           status="Open" ;;
        "in progress"|"working") status="In Progress" ;;
        "on hold"|"pending"|"waiting") status="On Hold" ;;
        "resolved"|"done"|"complete") status="Resolved" ;;
        "closed")               status="Closed" ;;
    esac

    local data
    data=$(jq -n --arg status "$status" '{
        "request": {
            "status": {
                "name": $status
            }
        }
    }')

    api_call PUT "/requests/${id}" "$data"
    echo "Status updated to: ${status}"
}

cmd_search() {
    local query="$1"

    local filter
    filter=$(jq -n --arg q "$query" '{
        "list_info": {
            "row_count": 20,
            "search_criteria": {
                "field": "subject",
                "condition": "contains",
                "value": $q
            }
        }
    }')

    echo "Search Results for: ${query}"
    echo "=========================="
    api_call GET "/requests" "$filter" | format_ticket_list
}

# =============================================================================
# Main
# =============================================================================

cmd="${1:-help}"
shift || true

case "$cmd" in
    list)
        cmd_list
        ;;
    get)
        if [[ "${2:-}" == "--json" ]]; then
            cmd_get "$1"
        else
            cmd_get_formatted "${1:?Usage: sdp-api get <ticket-id>}"
        fi
        ;;
    note)
        cmd_note "${1:?Usage: sdp-api note <ticket-id> <message>}" "${2:?Message required}"
        ;;
    status)
        cmd_status "${1:?Usage: sdp-api status <ticket-id> <status>}" "${2:?Status required}"
        ;;
    search)
        cmd_search "${1:?Usage: sdp-api search <query>}"
        ;;
    help|--help|-h)
        cat <<EOF
sdp-api - ServiceDesk Plus API helper

Usage:
  sdp-api list                     List my assigned tickets
  sdp-api get <id>                 Get ticket details (formatted)
  sdp-api get <id> --json          Get ticket details (raw JSON)
  sdp-api note <id> "<message>"    Add note to ticket
  sdp-api status <id> "<status>"   Update ticket status
  sdp-api search "<query>"         Search tickets

Environment:
  SDP_BASE_URL      Your SDP instance URL
  SDP_API_KEY       API technician key
  SDP_TECHNICIAN_ID Your technician ID (optional, for filtering)

Examples:
  sdp-api list
  sdp-api get SDP-12345
  sdp-api note 12345 "Deployed fix to staging"
  sdp-api status 12345 "In Progress"
  sdp-api search "login timeout"
EOF
        ;;
    *)
        echo "Unknown command: $cmd" >&2
        echo "Run 'sdp-api help' for usage" >&2
        exit 1
        ;;
esac
