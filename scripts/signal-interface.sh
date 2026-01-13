#!/usr/bin/env bash
# signal-interface.sh - Signal as a command interface for PAI
#
# Listens for incoming Signal messages and executes commands.
# Sends responses back via Signal.
#
# Usage:
#   signal-interface.sh              # Run listener (foreground)
#   signal-interface.sh send "msg"   # Send a message
#   signal-interface.sh status       # Check signal-cli status
#   signal-interface.sh link         # Link to phone (QR code)

set -uo pipefail

# Configuration - phone number from bws or env
SIGNAL_PHONE="${SIGNAL_PHONE:-}"
SIGNAL_DATA_DIR="${HOME}/.local/share/signal-cli"
POLL_INTERVAL=5  # seconds between message checks

# Load bws helpers if available
if [[ -f "$HOME/repos/github.com/sethdf/imladris/scripts/bws-init.sh" ]]; then
    source "$HOME/repos/github.com/sethdf/imladris/scripts/bws-init.sh" 2>/dev/null || true
fi

# Get phone number
_get_phone() {
    if [[ -n "$SIGNAL_PHONE" ]]; then
        echo "$SIGNAL_PHONE"
        return
    fi

    # Try bws
    if command -v bws_get &>/dev/null; then
        local phone
        phone=$(bws_get "signal-phone" 2>/dev/null || echo "")
        if [[ -n "$phone" ]]; then
            echo "$phone"
            return
        fi
    fi

    # Try to find from signal-cli data
    if [[ -d "$SIGNAL_DATA_DIR/data" ]]; then
        local found=""
        for f in "$SIGNAL_DATA_DIR/data"/+*; do
            [[ -e "$f" ]] || continue
            found=$(basename "$f")
            break
        done
        if [[ -n "$found" ]]; then
            echo "$found"
            return
        fi
    fi

    echo ""
}

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# =============================================================================
# Commands
# =============================================================================

cmd_status() {
    local phone
    phone=$(_get_phone)

    echo "=== Signal Interface Status ==="

    if ! command -v signal-cli &>/dev/null; then
        echo "signal-cli: NOT INSTALLED"
        echo "Install via: nix (already in home.nix) or https://github.com/AsamK/signal-cli"
        return 1
    fi
    echo "signal-cli: installed ($(signal-cli --version 2>/dev/null | head -1))"

    if [[ -z "$phone" ]]; then
        echo "phone: NOT CONFIGURED"
        echo "Run: signal-interface.sh link"
        return 1
    fi
    echo "phone: $phone"

    if [[ -d "$SIGNAL_DATA_DIR/data/$phone" ]]; then
        echo "linked: YES"
    else
        echo "linked: NO"
        echo "Run: signal-interface.sh link"
        return 1
    fi

    # Test by getting profile
    if signal-cli -u "$phone" getSelfNumber &>/dev/null; then
        echo "connection: OK"
    else
        echo "connection: FAILED"
        return 1
    fi
}

cmd_link() {
    echo "=== Link Signal CLI to your phone ==="
    echo ""
    echo "1. Open Signal on your phone"
    echo "2. Go to Settings > Linked Devices"
    echo "3. Tap '+' to add a new device"
    echo "4. Scan the QR code below:"
    echo ""

    # Generate link with device name
    local device_name
    device_name="${HOSTNAME:-devbox}-$(date +%Y%m%d)"
    signal-cli link -n "$device_name"

    echo ""
    echo "After scanning, your phone number will be registered."
    echo "Add it to bws: bws secret create signal-phone '+1XXXXXXXXXX'"
}

cmd_send() {
    local message="$1"
    local phone
    phone=$(_get_phone)

    if [[ -z "$phone" ]]; then
        echo "Error: No phone number configured" >&2
        return 1
    fi

    # Send to self
    signal-cli -u "$phone" send -m "$message" "$phone"
}

cmd_receive() {
    local phone
    phone=$(_get_phone)

    if [[ -z "$phone" ]]; then
        echo "Error: No phone number configured" >&2
        return 1
    fi

    # Receive messages as JSON
    signal-cli -u "$phone" receive --json 2>/dev/null
}

# =============================================================================
# Command Processing
# =============================================================================

process_command() {
    local cmd="$1"
    local response=""

    # Normalize command
    cmd=$(echo "$cmd" | tr '[:upper:]' '[:lower:]' | xargs)

    case "$cmd" in
        status|st)
            response=$(auth-keeper status 2>&1 || echo "auth-keeper not loaded")
            ;;
        aws\ status|aws\ st)
            response=$(_ak_aws_token_valid && echo "AWS SSO: valid" || echo "AWS SSO: expired")
            ;;
        azure\ status|az\ status)
            response=$(_ak_azure_token_valid && echo "Azure: valid" || echo "Azure: expired")
            ;;
        help|h|\?)
            response="Commands:
status - Show auth status
aws status - AWS SSO status
azure status - Azure status
ping - Test connection
help - This message"
            ;;
        ping|p)
            response="pong from $(hostname) at $(date '+%H:%M:%S')"
            ;;
        uptime)
            response=$(uptime -p)
            ;;
        ip)
            response=$(tailscale ip -4 2>/dev/null || hostname -I | awk '{print $1}')
            ;;
        *)
            # Unknown command - could extend to run arbitrary commands (careful!)
            response="Unknown: $cmd (try 'help')"
            ;;
    esac

    echo "$response"
}

cmd_listen() {
    local phone
    phone=$(_get_phone)

    if [[ -z "$phone" ]]; then
        echo "Error: No phone number configured" >&2
        echo "Run: signal-interface.sh link"
        return 1
    fi

    log "Starting Signal listener for $phone"
    log "Commands will be processed and responses sent back"

    # Load auth-keeper for status commands
    if [[ -f "$HOME/repos/github.com/sethdf/imladris/scripts/auth-keeper.sh" ]]; then
        source "$HOME/repos/github.com/sethdf/imladris/scripts/auth-keeper.sh" 2>/dev/null || true
    fi

    while true; do
        # Receive messages
        local messages
        messages=$(signal-cli -u "$phone" receive --json 2>/dev/null || echo "")

        if [[ -n "$messages" ]]; then
            # Process each message
            echo "$messages" | jq -c 'select(.envelope.dataMessage.message != null)' 2>/dev/null | while read -r msg; do
                local sender body
                sender=$(echo "$msg" | jq -r '.envelope.source // empty')
                body=$(echo "$msg" | jq -r '.envelope.dataMessage.message // empty')

                if [[ -n "$body" && "$sender" == "$phone" ]]; then
                    log "Received from self: $body"

                    # Process command
                    local response
                    response=$(process_command "$body")

                    if [[ -n "$response" ]]; then
                        log "Responding: ${response:0:50}..."
                        signal-cli -u "$phone" send -m "$response" "$phone" 2>/dev/null || true
                    fi
                fi
            done
        fi

        sleep "$POLL_INTERVAL"
    done
}

# =============================================================================
# Main
# =============================================================================

case "${1:-listen}" in
    status|st)
        cmd_status
        ;;
    link)
        cmd_link
        ;;
    send)
        shift
        cmd_send "$*"
        ;;
    receive)
        cmd_receive
        ;;
    listen|daemon)
        cmd_listen
        ;;
    help|--help|-h)
        cat <<'EOF'
signal-interface.sh - Signal as a command interface

Usage:
  signal-interface.sh              Run listener (default)
  signal-interface.sh status       Check signal-cli status
  signal-interface.sh link         Link to phone (QR code)
  signal-interface.sh send "msg"   Send a message to yourself
  signal-interface.sh receive      Receive pending messages (JSON)

Environment:
  SIGNAL_PHONE    Your phone number (+1XXXXXXXXXX)
                  Or set via bws: bws secret create signal-phone "+1..."

Commands you can send via Signal:
  status          Show auth-keeper status
  ping            Test connection
  uptime          Show system uptime
  ip              Show IP address
  help            List commands
EOF
        ;;
    *)
        echo "Unknown command: $1"
        echo "Run: signal-interface.sh help"
        exit 1
        ;;
esac
