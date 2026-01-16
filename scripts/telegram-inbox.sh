#!/usr/bin/env bash
# telegram-inbox.sh - Capture incoming Telegram messages to inbox
#
# Listens for Telegram messages and saves them to ~/inbox/
# Processes commands prefixed with /
#
# Usage:
#   telegram-inbox.sh              # Run listener (foreground)
#   telegram-inbox.sh daemon       # Run in background
#   telegram-inbox.sh status       # Check status

set -uo pipefail

INBOX_DIR="${INBOX_DIR:-$HOME/inbox}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
LOG_FILE="${LOG_FILE:-$HOME/.local/state/telegram-inbox.log}"
OFFSET_FILE="${HOME}/.local/state/telegram-inbox.offset"

mkdir -p "$INBOX_DIR" "$(dirname "$LOG_FILE")" "$(dirname "$OFFSET_FILE")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

get_token() {
    local token="${TELEGRAM_BOT_TOKEN:-}"
    if [[ -z "$token" ]]; then
        token=$(bws secret list 2>/dev/null | jq -r '.[] | select(.key == "telegram-bot-token") | .value')
    fi
    echo "$token"
}

get_chat_id() {
    local chat="${TELEGRAM_CHAT_ID:-}"
    if [[ -z "$chat" ]]; then
        chat=$(bws secret list 2>/dev/null | jq -r '.[] | select(.key == "telegram-chat-id") | .value')
    fi
    echo "$chat"
}

# Get last processed update offset
get_offset() {
    if [[ -f "$OFFSET_FILE" ]]; then
        cat "$OFFSET_FILE"
    else
        echo "0"
    fi
}

# Save offset
save_offset() {
    echo "$1" > "$OFFSET_FILE"
}

# Save message to inbox
save_to_inbox() {
    local from="$1"
    local timestamp="$2"
    local message="$3"

    local date_str=$(date -d "@$timestamp" '+%Y-%m-%d')
    local time_str=$(date -d "@$timestamp" '+%H:%M:%S')
    local filename="$INBOX_DIR/${date_str}_$(date -d "@$timestamp" '+%H%M%S')_telegram.md"

    cat > "$filename" << EOF
---
source: telegram
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

# Process commands
process_command() {
    local cmd="$1"
    local response=""

    case "$cmd" in
        /ping|/p)
            response="pong from $(hostname) at $(date '+%H:%M:%S')"
            ;;
        /status|/st)
            response="$(source ~/.zshrc 2>/dev/null; auth-keeper status 2>&1 | head -10)"
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
        /inbox)
            response="Recent captures:
$(ls -t "$INBOX_DIR"/*.md 2>/dev/null | head -5 | xargs -I{} basename {})"
            ;;
        /help|/h|/?)
            response="Commands:
/ping - Test connection
/status - Auth status
/ip - Show IP
/uptime - System uptime
/disk - Disk usage
/inbox - Recent captures
/help - This message

Text without / is saved to inbox."
            ;;
        /start)
            response="Curu inbox ready! Send any text to capture, or /help for commands."
            ;;
        *)
            return 1
            ;;
    esac

    echo "$response"
    return 0
}

# Send response
send_response() {
    local token="$1"
    local chat_id="$2"
    local message="$3"

    curl -s "https://api.telegram.org/bot${token}/sendMessage" \
        -d "chat_id=${chat_id}" \
        -d "text=${message}" &>/dev/null
}

# Main listener
listen() {
    local token=$(get_token)
    local my_chat=$(get_chat_id)

    if [[ -z "$token" ]]; then
        log "ERROR: No telegram token"
        exit 1
    fi

    log "Starting Telegram inbox listener"
    log "Inbox: $INBOX_DIR"
    log "My chat ID: $my_chat"

    local offset=$(get_offset)

    while true; do
        local response
        response=$(curl -s "https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30")

        if echo "$response" | jq -e '.ok' &>/dev/null; then
            echo "$response" | jq -c '.result[]' 2>/dev/null | while read -r update; do
                local update_id msg_text chat_id from_name timestamp

                update_id=$(echo "$update" | jq -r '.update_id')
                msg_text=$(echo "$update" | jq -r '.message.text // empty')
                chat_id=$(echo "$update" | jq -r '.message.chat.id // empty')
                from_name=$(echo "$update" | jq -r '.message.from.first_name // "Unknown"')
                timestamp=$(echo "$update" | jq -r '.message.date // 0')

                # Update offset
                save_offset $((update_id + 1))
                offset=$((update_id + 1))

                # Skip if not from my chat or empty
                [[ -z "$msg_text" ]] && continue
                [[ "$chat_id" != "$my_chat" ]] && continue

                log "Received: ${msg_text:0:50}..."

                # Check if command
                if [[ "$msg_text" == /* ]]; then
                    local cmd_response
                    if cmd_response=$(process_command "$msg_text"); then
                        send_response "$token" "$chat_id" "$cmd_response"
                        log "Command response sent"
                    else
                        save_to_inbox "$from_name" "$timestamp" "$msg_text"
                    fi
                else
                    save_to_inbox "$from_name" "$timestamp" "$msg_text"
                    send_response "$token" "$chat_id" "✓ Captured"
                fi
            done
        fi

        sleep "$POLL_INTERVAL"
    done
}

check_status() {
    echo "=== Telegram Inbox Status ==="

    local token=$(get_token)
    if [[ -n "$token" ]]; then
        echo "Token: configured"
    else
        echo "Token: missing"
        return 1
    fi

    local chat=$(get_chat_id)
    if [[ -n "$chat" ]]; then
        echo "Chat ID: $chat"
    else
        echo "Chat ID: missing"
    fi

    local count=$(ls "$INBOX_DIR"/*.md 2>/dev/null | wc -l)
    echo "Inbox: $INBOX_DIR ($count items)"

    if pgrep -f "telegram-inbox.sh" &>/dev/null; then
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
        echo "Started (PID: $!)"
        ;;
    status|st)
        check_status
        ;;
    stop)
        pkill -f "telegram-inbox.sh listen" && echo "Stopped" || echo "Not running"
        ;;
    help|--help|-h)
        cat << 'EOF'
telegram-inbox.sh - Capture Telegram messages to inbox

Usage:
  telegram-inbox.sh              Run listener
  telegram-inbox.sh daemon       Run in background
  telegram-inbox.sh status       Check status
  telegram-inbox.sh stop         Stop daemon

From Telegram, message your bot:
  - Any text -> saved to ~/inbox/, you get ✓
  - /ping, /status, /help -> commands
EOF
        ;;
    *)
        echo "Unknown: $1"
        exit 1
        ;;
esac
