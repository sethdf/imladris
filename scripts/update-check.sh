#!/usr/bin/env bash
# update-check.sh - Daily check for AI tooling updates
# Checks: PAI, Claude Code, MCP servers, skills repos, simplex-chat
# Notifications: via SimpleX (local encrypted messaging)
set -euo pipefail

# Configuration
SIMPLEX_CLI="${SIMPLEX_CLI:-$HOME/.local/bin/simplex-chat}"
NOTIFY_CONTACT="${UPDATE_NOTIFY_CONTACT:-}"  # Set to SimpleX contact name
REPORT_FILE="${UPDATE_CHECK_REPORT:-$HOME/.cache/imladris/update-check-report.txt}"

# Logging (follows imladris conventions)
log() { echo "[$(date '+%H:%M:%S')] $*"; }
log_success() { echo "[$(date '+%H:%M:%S')] ✓ $*"; }
log_warn() { echo "[$(date '+%H:%M:%S')] ⚠ $*"; }
log_error() { echo "[$(date '+%H:%M:%S')] ✗ $*" >&2; }

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# SimpleX notification (E2E encrypted)
notify_simplex() {
    local message="$1"
    if [[ -n "$NOTIFY_CONTACT" && -x "$SIMPLEX_CLI" ]]; then
        "$SIMPLEX_CLI" "@$NOTIFY_CONTACT $message" 2>/dev/null &
    fi
}

# Check git repo for updates
# Returns: 0 if up-to-date, 1 if updates available
# Outputs: status message to stdout
check_repo() {
    local name="$1"
    local path="$2"

    # Check if repo exists
    if [[ ! -d "$path/.git" ]]; then
        echo "$name: not found at $path"
        return 1
    fi

    # Fetch latest from remote
    if ! git -C "$path" fetch --quiet 2>/dev/null; then
        echo "$name: fetch failed"
        return 1
    fi

    # Count commits behind upstream
    local behind
    behind=$(git -C "$path" rev-list --count HEAD..@{upstream} 2>/dev/null || echo "0")

    if [[ "$behind" -gt 0 ]]; then
        local latest_commit
        latest_commit=$(git -C "$path" log --oneline @{upstream} -1 2>/dev/null | cut -c1-50)
        echo "$name: $behind commits behind (latest: $latest_commit)"
        return 1
    fi

    return 0
}

# Check bun global packages for updates
# Outputs: outdated packages to stdout
check_bun() {
    if ! command -v bun &>/dev/null; then
        return 0
    fi

    local outdated
    outdated=$(bun outdated -g 2>/dev/null | grep -E "(claude-code|modelcontextprotocol)" || true)

    if [[ -n "$outdated" ]]; then
        echo "$outdated"
        return 1
    fi
    return 0
}

# Check simplex-chat CLI for updates via GitHub releases
check_simplex() {
    # Skip if not installed
    if [[ ! -x "$SIMPLEX_CLI" ]]; then
        return 0
    fi

    # Get current version
    local current
    current=$("$SIMPLEX_CLI" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
    [[ -z "$current" ]] && return 0

    # Get latest release from GitHub
    local latest
    latest=$(curl -sL --max-time 10 "https://api.github.com/repos/simplex-chat/simplex-chat/releases/latest" \
        | jq -r '.tag_name // empty' 2>/dev/null | tr -d 'v')

    if [[ -n "$latest" && "$latest" != "$current" ]]; then
        echo "simplex-chat: $current → $latest"
        return 1
    fi

    return 0
}

# Generate full update report
generate_report() {
    local updates=()
    local report=""
    local has_updates=0

    log "Checking PAI..."
    local pai_check
    pai_check=$(check_repo "PAI" "$HOME/repos/github.com/danielmiessler/Personal_AI_Infrastructure" 2>&1) || true
    if [[ $? -ne 0 || "$pai_check" == *"behind"* || "$pai_check" == *"not found"* ]]; then
        updates+=("PAI")
        report+="$pai_check\n"
        has_updates=1
    fi

    log "Checking Claude Code & MCP servers..."
    local bun_check
    bun_check=$(check_bun 2>&1) || true
    if [[ -n "$bun_check" ]]; then
        updates+=("Bun packages")
        report+="$bun_check\n"
        has_updates=1
    fi

    log "Checking Curu Skills..."
    local curu_check
    curu_check=$(check_repo "Curu Skills" "$HOME/repos/github.com/sethdf/curu-skills" 2>&1) || true
    if [[ "$curu_check" == *"behind"* || "$curu_check" == *"not found"* ]]; then
        updates+=("Curu Skills")
        report+="$curu_check\n"
        has_updates=1
    fi

    log "Checking Anthropic Skills..."
    local anthropic_check
    anthropic_check=$(check_repo "Anthropic Skills" "$HOME/repos/github.com/anthropics/skills" 2>&1) || true
    if [[ "$anthropic_check" == *"behind"* || "$anthropic_check" == *"not found"* ]]; then
        updates+=("Anthropic Skills")
        report+="$anthropic_check\n"
        has_updates=1
    fi

    log "Checking SimpleX Chat..."
    local simplex_check
    simplex_check=$(check_simplex 2>&1) || true
    if [[ -n "$simplex_check" ]]; then
        updates+=("simplex-chat")
        report+="$simplex_check\n"
        has_updates=1
    fi

    # Save report to file
    mkdir -p "$(dirname "$REPORT_FILE")"
    {
        echo "Update Check: $(date '+%Y-%m-%d %H:%M')"
        echo "============================================"
        if [[ $has_updates -eq 1 ]]; then
            echo ""
            echo -e "$report"
        else
            echo ""
            echo "All components up to date."
        fi
    } > "$REPORT_FILE"

    # Return results
    if [[ ${#updates[@]} -gt 0 ]]; then
        echo "${updates[*]}"
        return 1
    fi
    return 0
}

# Display help
show_help() {
    cat << 'EOF'
Usage: update-check [COMMAND]

Daily check for AI tooling updates.

Commands:
  check     Run update check (default)
  report    Show last report
  notify    Test SimpleX notification
  help      Show this help

Checks:
  - PAI (Personal AI Infrastructure)
  - Claude Code (@anthropic-ai/claude-code)
  - MCP servers (@modelcontextprotocol/*)
  - Curu Skills (sethdf/curu-skills)
  - Anthropic Skills (anthropics/skills)
  - SimpleX Chat CLI

Environment:
  UPDATE_NOTIFY_CONTACT   SimpleX contact for notifications
  SIMPLEX_CLI             Path to simplex-chat (default: ~/.local/bin/simplex-chat)
  UPDATE_CHECK_REPORT     Path to report file

Examples:
  update-check                              # Run check
  UPDATE_NOTIFY_CONTACT=myphone update-check  # Check with notifications
  update-check report                       # View last report
EOF
}

# Main entry point
main() {
    case "${1:-check}" in
        check)
            echo ""
            echo -e "${GREEN}AI Tooling Update Check${NC}"
            echo "========================"
            echo ""

            local result
            result=$(generate_report) || true

            echo ""
            if [[ -n "$result" ]]; then
                echo -e "${YELLOW}Updates available:${NC} $result"
                notify_simplex "Updates available: $result"
                echo ""
                cat "$REPORT_FILE"
                exit 1
            else
                echo -e "${GREEN}All components up to date${NC}"
                exit 0
            fi
            ;;

        report)
            if [[ -f "$REPORT_FILE" ]]; then
                cat "$REPORT_FILE"
            else
                echo "No report available. Run 'update-check' first."
                exit 1
            fi
            ;;

        notify)
            if [[ -z "$NOTIFY_CONTACT" ]]; then
                log_error "UPDATE_NOTIFY_CONTACT not set"
                echo "Usage: UPDATE_NOTIFY_CONTACT=myphone update-check notify"
                exit 1
            fi
            log "Sending test notification to $NOTIFY_CONTACT..."
            notify_simplex "Update checker notification test"
            log_success "Notification sent"
            ;;

        help|--help|-h)
            show_help
            ;;

        *)
            log_error "Unknown command: $1"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
