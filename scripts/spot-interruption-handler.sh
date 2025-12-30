#!/bin/bash
# spot-interruption-handler.sh - Handle Spot instance interruption warning
# Runs as systemd service, monitors metadata for interruption notice
# When detected, saves state and notifies before termination

set -euo pipefail

METADATA_URL="http://169.254.169.254/latest/meta-data/spot/instance-action"
TOKEN_URL="http://169.254.169.254/latest/api/token"
CHECK_INTERVAL=5  # seconds between checks
LOG_FILE="/var/log/spot-interruption-handler.log"
STATE_DIR="/home/ubuntu/.cache/spot-handler"
HANDLED_FILE="$STATE_DIR/interruption-handled"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

mkdir -p "$STATE_DIR"

# Get IMDSv2 token
get_token() {
    curl -s -X PUT "$TOKEN_URL" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || echo ""
}

# Check for spot interruption notice
check_interruption() {
    local token="$1"
    local response
    response=$(curl -s -H "X-aws-ec2-metadata-token: $token" "$METADATA_URL" 2>/dev/null || echo "")

    if [[ -n "$response" && "$response" != *"404"* && "$response" != *"Not Found"* ]]; then
        echo "$response"
        return 0
    fi
    return 1
}

# Save tmux sessions
save_tmux() {
    log "Saving tmux sessions..."

    # Run as ubuntu user
    if sudo -u ubuntu bash -c 'command -v tmux &>/dev/null && tmux list-sessions &>/dev/null'; then
        # Force resurrect save
        local resurrect_save="/home/ubuntu/.tmux/plugins/tmux-resurrect/scripts/save.sh"
        if [[ -x "$resurrect_save" ]]; then
            sudo -u ubuntu bash -c "TMUX='' $resurrect_save" 2>/dev/null && \
                log "  ✓ tmux sessions saved via resurrect" || \
                log "  ✗ tmux resurrect save failed"
        else
            log "  - tmux-resurrect not installed, skipping"
        fi
    else
        log "  - No tmux sessions running"
    fi
}

# Stash uncommitted git changes
save_git() {
    log "Stashing uncommitted git changes..."

    local stashed=0
    for dir in /home/ubuntu/code/*/ /home/ubuntu/projects/*/; do
        [[ -d "$dir/.git" ]] || continue

        local repo_name=$(basename "$dir")
        if [[ -n $(sudo -u ubuntu git -C "$dir" status --porcelain 2>/dev/null) ]]; then
            local stash_msg="spot-interruption-$(date +%Y%m%d-%H%M%S)"
            if sudo -u ubuntu git -C "$dir" stash push -m "$stash_msg" 2>/dev/null; then
                log "  ✓ Stashed changes in $repo_name"
                ((stashed++))
            else
                log "  ✗ Failed to stash $repo_name"
            fi
        fi
    done

    [[ $stashed -eq 0 ]] && log "  - No uncommitted changes to stash"
}

# Stop Docker containers gracefully
save_docker() {
    log "Stopping Docker containers gracefully..."

    local containers
    containers=$(docker ps -q 2>/dev/null | wc -l)

    if [[ $containers -gt 0 ]]; then
        # Give containers 30 seconds to stop gracefully
        docker stop $(docker ps -q) --time 30 2>/dev/null && \
            log "  ✓ Stopped $containers container(s)" || \
            log "  ✗ Failed to stop some containers"
    else
        log "  - No running containers"
    fi
}

# Sync filesystems
sync_filesystems() {
    log "Syncing filesystems..."
    sync
    log "  ✓ Filesystem sync complete"
}

# Send notification (SNS topic from Terraform)
send_notification() {
    local action_time="$1"

    log "Sending notification..."

    # Try to get instance ID and SNS topic from instance tags or environment
    local instance_id
    local token
    token=$(get_token)
    instance_id=$(curl -s -H "X-aws-ec2-metadata-token: $token" \
        "http://169.254.169.254/latest/meta-data/instance-id" 2>/dev/null || echo "unknown")

    # Try SNS notification if AWS CLI is available and topic is configured
    if command -v aws &>/dev/null; then
        # Look for SNS topic ARN in environment or config
        local sns_topic="${SPOT_NOTIFICATION_SNS_ARN:-}"

        if [[ -n "$sns_topic" ]]; then
            local message="Spot instance $instance_id received interruption notice.
Action time: $action_time

State saved:
- tmux sessions saved
- Git changes stashed
- Docker containers stopped
- Filesystem synced

Instance will terminate shortly. Lambda will auto-restart."

            aws sns publish \
                --topic-arn "$sns_topic" \
                --subject "Spot Interruption: $instance_id" \
                --message "$message" 2>/dev/null && \
                log "  ✓ SNS notification sent" || \
                log "  ✗ SNS notification failed"
        else
            log "  - No SNS topic configured (set SPOT_NOTIFICATION_SNS_ARN)"
        fi
    else
        log "  - AWS CLI not available for notification"
    fi
}

# Main interruption handler
handle_interruption() {
    local action_info="$1"

    # Prevent running twice
    if [[ -f "$HANDLED_FILE" ]]; then
        log "Interruption already handled, skipping"
        return 0
    fi
    touch "$HANDLED_FILE"

    local action_time
    action_time=$(echo "$action_info" | jq -r '.time // "unknown"' 2>/dev/null || echo "unknown")

    log "=========================================="
    log "SPOT INTERRUPTION NOTICE RECEIVED"
    log "Termination time: $action_time"
    log "=========================================="

    # Run all save operations
    save_tmux
    save_git
    save_docker
    sync_filesystems
    send_notification "$action_time"

    log "=========================================="
    log "STATE PRESERVATION COMPLETE"
    log "Instance will terminate at: $action_time"
    log "=========================================="
}

# Main monitoring loop
main() {
    log "Spot interruption handler started"
    log "Checking metadata every ${CHECK_INTERVAL}s..."

    # Clean up any previous handled file on fresh start
    rm -f "$HANDLED_FILE"

    local token
    local token_time=0

    while true; do
        # Refresh token every 4 minutes (expires at 5)
        local now
        now=$(date +%s)
        if [[ $((now - token_time)) -gt 240 ]]; then
            token=$(get_token)
            token_time=$now
        fi

        # Check for interruption
        local action_info
        if action_info=$(check_interruption "$token"); then
            handle_interruption "$action_info"
            # Keep running but don't handle again
            sleep 60
        fi

        sleep "$CHECK_INTERVAL"
    done
}

# Handle script arguments
case "${1:-}" in
    --test)
        log "TEST MODE: Simulating interruption..."
        handle_interruption '{"action":"terminate","time":"2024-01-15T12:00:00Z"}'
        ;;
    --check)
        token=$(get_token)
        if action_info=$(check_interruption "$token"); then
            echo "Interruption notice active: $action_info"
            exit 0
        else
            echo "No interruption notice"
            exit 1
        fi
        ;;
    *)
        main
        ;;
esac
