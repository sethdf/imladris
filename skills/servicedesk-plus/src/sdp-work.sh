#!/bin/bash
#
# sdp-work - ServiceDesk Plus ticket workflow manager
#
# Manages local ticket working directories with sync to SDP.
#
# Usage:
#   sdp-work start <id>      # Start working on a ticket
#   sdp-work sync [<id>]     # Sync notes to SDP (current ticket if in dir)
#   sdp-work reply [<id>]    # Draft and send reply to requester
#   sdp-work done [<id>]     # Finish work, sync notes, optionally resolve
#   sdp-work status          # Show current ticket context
#
set -euo pipefail

TICKETS_DIR="${SDP_TICKETS_DIR:-$HOME/work/tickets}"

# =============================================================================
# Helper Functions
# =============================================================================

get_ticket_id() {
    local id="${1:-}"

    # If no ID provided, try to get from current directory
    if [[ -z "$id" ]]; then
        if [[ -f .ticket.json ]]; then
            id=$(jq -r '.request.id // .id' .ticket.json 2>/dev/null || echo "")
        fi
        if [[ -z "$id" ]]; then
            echo "Error: No ticket ID provided and not in a ticket directory" >&2
            exit 1
        fi
    fi

    # Strip SDP- prefix if present
    echo "${id#SDP-}"
}

ticket_dir() {
    local id="$1"
    echo "${TICKETS_DIR}/SDP-${id}"
}

ensure_ticket_dir() {
    local id="$1"
    local dir
    dir=$(ticket_dir "$id")

    mkdir -p "${dir}/replies"
    mkdir -p "${dir}/files"
    echo "$dir"
}

# =============================================================================
# Commands
# =============================================================================

cmd_start() {
    local id
    id=$(get_ticket_id "${1:-}")
    local dir
    dir=$(ensure_ticket_dir "$id")

    echo "Setting up ticket SDP-${id}..."

    # Fetch ticket details
    echo "Fetching ticket from SDP..."
    sdp-api get "$id" --json > "${dir}/.ticket.json"

    # Create/update notes.md header if new
    if [[ ! -f "${dir}/notes.md" ]]; then
        local subject priority status
        subject=$(jq -r '.request.subject // "Unknown"' "${dir}/.ticket.json")
        priority=$(jq -r '.request.priority.name // "N/A"' "${dir}/.ticket.json")
        status=$(jq -r '.request.status.name // "N/A"' "${dir}/.ticket.json")

        cat > "${dir}/notes.md" <<EOF
# SDP-${id}: ${subject}

**Priority**: ${priority}
**Status**: ${status}
**Started**: $(date '+%Y-%m-%d %H:%M')

---

## Investigation Notes

<!--
Add your findings, root cause analysis, things tried, etc. here.
These notes will be synced to SDP as PRIVATE technician notes.
-->


---

## Files & References

-

EOF
    fi

    # Create sync state tracker
    echo '{"last_sync": null, "notes_hash": ""}' > "${dir}/.sync-state.json"

    # Pull existing notes from SDP
    echo "Fetching existing notes from SDP..."
    sdp-api get-notes "$id" > "${dir}/.sdp-notes.txt" 2>/dev/null || true

    echo ""
    echo "Ticket workspace ready: ${dir}"
    echo ""
    sdp-api get "$id"
    echo ""
    echo "Commands:"
    echo "  cd ${dir}           # Enter ticket directory"
    echo "  sdp-work sync       # Sync notes.md to SDP"
    echo "  sdp-work reply      # Send reply to requester"
    echo "  sdp-work done       # Finish and optionally resolve"
}

cmd_sync() {
    local id
    id=$(get_ticket_id "${1:-}")
    local dir
    dir=$(ticket_dir "$id")

    if [[ ! -f "${dir}/notes.md" ]]; then
        echo "Error: No notes.md found in ${dir}" >&2
        exit 1
    fi

    echo "Syncing notes to SDP-${id}..."
    sdp-api sync-notes "$id" "${dir}/notes.md"

    # Update sync state
    local hash
    hash=$(md5sum "${dir}/notes.md" | cut -d' ' -f1)
    jq --arg ts "$(date -Iseconds)" --arg hash "$hash" \
        '.last_sync = $ts | .notes_hash = $hash' \
        "${dir}/.sync-state.json" > "${dir}/.sync-state.json.tmp"
    mv "${dir}/.sync-state.json.tmp" "${dir}/.sync-state.json"

    echo "Notes synced successfully"
}

cmd_reply() {
    local id
    id=$(get_ticket_id "${1:-}")
    local dir
    dir=$(ticket_dir "$id")

    local reply_file="${dir}/replies/$(date '+%Y-%m-%d').md"

    # Create reply template if doesn't exist
    if [[ ! -f "$reply_file" ]]; then
        cat > "$reply_file" <<EOF
# Reply for SDP-${id}

<!--
Draft your reply to the requester here.
This will be sent as a PUBLIC response visible to the requester.
-->



EOF
    fi

    echo "Reply file: ${reply_file}"
    echo ""
    echo "Edit the file, then run:"
    echo "  sdp-work send-reply ${id}"
    echo ""
    echo "Or provide message directly:"
    echo "  sdp-api reply ${id} \"Your message here\""
}

cmd_send_reply() {
    local id
    id=$(get_ticket_id "${1:-}")
    local dir
    dir=$(ticket_dir "$id")

    local reply_file="${dir}/replies/$(date '+%Y-%m-%d').md"

    if [[ ! -f "$reply_file" ]]; then
        echo "Error: No reply draft found at ${reply_file}" >&2
        exit 1
    fi

    # Extract content (skip header comments)
    local content
    content=$(sed '/^<!--/,/^-->/d; /^# Reply/d' "$reply_file" | sed '/^$/N;/^\n$/d')

    if [[ -z "$content" ]]; then
        echo "Error: Reply is empty" >&2
        exit 1
    fi

    echo "Sending reply to requester..."
    echo "---"
    echo "$content"
    echo "---"
    echo ""
    read -p "Send this reply? [y/N] " -n 1 -r
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        sdp-api reply "$id" "$content"
        mv "$reply_file" "${reply_file%.md}.sent.md"
        echo "Reply sent and archived"
    else
        echo "Reply cancelled"
    fi
}

cmd_done() {
    local id
    id=$(get_ticket_id "${1:-}")
    local dir
    dir=$(ticket_dir "$id")

    echo "Finishing work on SDP-${id}..."

    # Sync notes
    if [[ -f "${dir}/notes.md" ]]; then
        echo "Syncing final notes..."
        sdp-api sync-notes "$id" "${dir}/notes.md"
    fi

    # Ask about resolution
    echo ""
    read -p "Update ticket status? [y/N] " -n 1 -r
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Status options: In Progress, On Hold, Resolved, Closed"
        read -p "New status: " status
        if [[ -n "$status" ]]; then
            sdp-api status "$id" "$status"
        fi
    fi

    echo ""
    echo "Work on SDP-${id} complete"
    echo "Ticket directory preserved at: ${dir}"
}

cmd_status() {
    if [[ -f .ticket.json ]]; then
        local id subject status
        id=$(jq -r '.request.id // .id' .ticket.json)
        subject=$(jq -r '.request.subject // "Unknown"' .ticket.json)
        status=$(jq -r '.request.status.name // "N/A"' .ticket.json)

        echo "Current ticket: SDP-${id}"
        echo "Subject: ${subject}"
        echo "Status: ${status}"
        echo ""

        if [[ -f .sync-state.json ]]; then
            local last_sync
            last_sync=$(jq -r '.last_sync // "Never"' .sync-state.json)
            echo "Last sync: ${last_sync}"
        fi
    else
        echo "Not in a ticket directory"
        echo ""
        echo "Recent tickets:"
        ls -1t "$TICKETS_DIR" 2>/dev/null | head -5 || echo "  (none)"
    fi
}

# =============================================================================
# Main
# =============================================================================

cmd="${1:-status}"
shift || true

case "$cmd" in
    start|open|work)
        cmd_start "${1:-}"
        ;;
    sync)
        cmd_sync "${1:-}"
        ;;
    reply)
        cmd_reply "${1:-}"
        ;;
    send-reply)
        cmd_send_reply "${1:-}"
        ;;
    done|finish|close)
        cmd_done "${1:-}"
        ;;
    status|info)
        cmd_status
        ;;
    help|--help|-h)
        cat <<EOF
sdp-work - ServiceDesk Plus ticket workflow manager

Usage:
  sdp-work start <id>       Start working on a ticket (creates workspace)
  sdp-work sync [<id>]      Sync notes.md to SDP as private note
  sdp-work reply [<id>]     Create/edit reply draft
  sdp-work send-reply [<id>] Send the reply draft to requester
  sdp-work done [<id>]      Finish work, sync notes, update status
  sdp-work status           Show current ticket context

Directory Structure:
  ~/work/tickets/SDP-12345/
  ├── .ticket.json          Cached ticket metadata
  ├── .sync-state.json      Sync tracking
  ├── .sdp-notes.txt        Notes pulled from SDP
  ├── notes.md              Your working notes (syncs to SDP PRIVATE)
  ├── replies/              Reply drafts (sends to SDP PUBLIC)
  │   └── 2025-01-08.md
  └── files/                Attachments, screenshots, code

Workflow:
  1. sdp-work start 12345   # Set up workspace, pull ticket
  2. cd ~/work/tickets/SDP-12345
  3. # Work on the issue, add to notes.md
  4. sdp-work sync          # Push notes to SDP (private)
  5. sdp-work reply         # Draft response to requester
  6. sdp-work send-reply    # Send the response (public)
  7. sdp-work done          # Final sync, update status

Notes vs Replies:
  notes.md   → Syncs as PRIVATE technician notes (internal only)
  replies/   → Sends as PUBLIC responses (visible to requester)
EOF
        ;;
    *)
        echo "Unknown command: $cmd" >&2
        echo "Run 'sdp-work help' for usage" >&2
        exit 1
        ;;
esac
