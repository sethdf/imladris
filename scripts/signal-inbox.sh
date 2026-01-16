#!/usr/bin/env bash
# signal-inbox.sh - Capture incoming Signal messages to inbox
#
# Listens for Signal messages and saves them to ~/inbox/
# Can also process special commands prefixed with /
#
# Usage:
#   signal-inbox.sh              # Run listener (foreground)
#   signal-inbox.sh daemon       # Run in background
#   signal-inbox.sh status       # Check status
#   signal-inbox.sh recent       # Show recent captures

set -uo pipefail

SIGNAL_API_URL="${SIGNAL_API_URL:-http://127.0.0.1:8080}"
INBOX_DIR="${INBOX_DIR:-$HOME/inbox}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
LOG_FILE="${LOG_FILE:-$HOME/.local/state/signal-inbox.log}"

# Ensure directories exist
mkdir -p "$INBOX_DIR" "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

get_phone() {
    local phone="${SIGNAL_PHONE:-}"
    if [[ -z "$phone" ]]; then
        phone=$(bws secret list 2>/dev/null | jq -r '.[] | select(.key == "signal-phone") | .value')
    fi
    echo "$phone"
}

# Save message to inbox
save_to_inbox() {
    local from="$1"
    local timestamp="$2"
    local message="$3"

    local date_str=$(date -d "@$timestamp" '+%Y-%m-%d')
    local time_str=$(date -d "@$timestamp" '+%H:%M:%S')
    local filename="$INBOX_DIR/${date_str}_$(date -d "@$timestamp" '+%H%M%S')_signal.md"

    cat > "$filename" << EOF
---
source: signal
from: $from
timestamp: $timestamp
date: $date_str $time_str
captured: $(date -Iseconds)
---

$message
EOF

    log "Captured: ${message:0:50}... -> $filename"
    echo "$filename"
}

# Process special commands (messages starting with /)
process_command() {
    local cmd="$1"
    local response=""

    case "$cmd" in
        /ping|/p)
            response="pong from $(hostname) at $(date '+%H:%M:%S')"
            ;;
        /status|/st)
            response="$(auth-keeper status 2>&1 | head -10)"
            ;;
        /ip)
            response="$(tailscale ip -4 2>/dev/null || hostname -I | awk '{print $1}')"
            ;;
        /uptime)
            response="$(uptime -p)"
            ;;
        /disk)
            response="$(df -h / | tail -1 | awk '{print "Disk: "$5" used ("$3"/"$2")"}')"
            ;;
        /help|/h|/?)
            response="Commands:
/ping - Test connection
/status - Auth status
/ip - Show IP
/uptime - System uptime
/disk - Disk usage
/help - This message

Anything else is captured to inbox."
            ;;
        *)
            # Not a command, return empty (will be saved to inbox)
            return 1
            ;;
    esac

    echo "$response"
    return 0
}

# Send response back via Signal
send_response() {
    local phone="$1"
    local message="$2"

    curl -s "${SIGNAL_API_URL}/v1/send" -X POST \
        -H "Content-Type: application/json" \
        -d "$(jq -n --arg msg "$message" --arg num "$phone" \
            '{message:$msg,number:$num,recipients:[$num]}')" &>/dev/null
}

# Main listener loop
listen() {
    local phone=$(get_phone)

    if [[ -z "$phone" ]]; then
        log "ERROR: No phone configured"
        exit 1
    fi

    log "Starting Signal inbox listener for $phone"
    log "Inbox: $INBOX_DIR"
    log "Poll interval: ${POLL_INTERVAL}s"

    while true; do
        # Receive messages
        local response
        response=$(curl -s "${SIGNAL_API_URL}/v1/receive/$phone" 2>/dev/null)

        if [[ -n "$response" && "$response" != "null" && "$response" != "[]" ]]; then
            # Process each message
            echo "$response" | jq -c '.[]' 2>/dev/null | while read -r msg; do
                local msg_text sender timestamp

                # Extract message details
                msg_text=$(echo "$msg" | jq -r '.envelope.dataMessage.message // empty')
                sender=$(echo "$msg" | jq -r '.envelope.sourceName // .envelope.sourceNumber // "unknown"')
                timestamp=$(echo "$msg" | jq -r '.envelope.timestamp // 0')
                timestamp=$((timestamp / 1000))  # Convert ms to seconds

                # Skip empty messages
                [[ -z "$msg_text" ]] && continue

                log "Received from $sender: ${msg_text:0:50}..."

                # Check if it's a command
                if [[ "$msg_text" == /* ]]; then
                    local cmd_response
                    if cmd_response=$(process_command "$msg_text"); then
                        send_response "$phone" "$cmd_response"
                        log "Command response sent"
                    else
                        # Command not recognized, save to inbox
                        save_to_inbox "$sender" "$timestamp" "$msg_text"
                    fi
                else
                    # Regular message - save to inbox
                    save_to_inbox "$sender" "$timestamp" "$msg_text"
                fi
            done
        fi

        sleep "$POLL_INTERVAL"
    done
}

# Show recent inbox captures
show_recent() {
    echo "Recent inbox captures:"
    echo ""
    ls -lt "$INBOX_DIR"/*.md 2>/dev/null | head -10 | while read -r line; do
        local file=$(echo "$line" | awk '{print $NF}')
        local preview=$(grep -A1 "^---$" "$file" | tail -1 | head -c 60)
        echo "$(basename "$file"): $preview..."
    done
}

# Check status
check_status() {
    echo "=== Signal Inbox Status ==="

    # Check API
    if curl -s --max-time 2 "${SIGNAL_API_URL}/v1/about" &>/dev/null; then
        echo "API: running"
    else
        echo "API: not running"
        return 1
    fi

    # Check phone
    local phone=$(get_phone)
    if [[ -n "$phone" ]]; then
        echo "Phone: $phone"
    else
        echo "Phone: not configured"
        return 1
    fi

    # Check inbox dir
    local count=$(ls "$INBOX_DIR"/*.md 2>/dev/null | wc -l)
    echo "Inbox: $INBOX_DIR ($count items)"

    # Check if listener is running
    if pgrep -f "signal-inbox.sh" &>/dev/null; then
        echo "Listener: running"
    else
        echo "Listener: not running"
    fi
}

case "${1:-listen}" in
    listen|start)
        listen
        ;;
    daemon|bg)
        nohup "$0" listen >> "$LOG_FILE" 2>&1 &
        echo "Started in background (PID: $!)"
        echo "Log: $LOG_FILE"
        ;;
    status|st)
        check_status
        ;;
    recent|ls)
        show_recent
        ;;
    stop)
        pkill -f "signal-inbox.sh listen" && echo "Stopped" || echo "Not running"
        ;;
    help|--help|-h)
        cat << 'EOF'
signal-inbox.sh - Capture Signal messages to inbox

Usage:
  signal-inbox.sh              Run listener (foreground)
  signal-inbox.sh daemon       Run in background
  signal-inbox.sh status       Check status
  signal-inbox.sh recent       Show recent captures
  signal-inbox.sh stop         Stop daemon

Environment:
  INBOX_DIR       Where to save captures (default: ~/inbox)
  POLL_INTERVAL   Seconds between checks (default: 5)

From your phone, send messages to yourself:
  - Regular text -> saved to ~/inbox/
  - /ping, /status, /help -> commands, response sent back
EOF
        ;;
    *)
        echo "Unknown: $1 (try: signal-inbox.sh help)"
        exit 1
        ;;
esac
