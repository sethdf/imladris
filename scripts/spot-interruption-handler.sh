#!/bin/bash
# spot-interruption-handler.sh - Handle Spot instance interruption warning
# Runs as systemd service, monitors metadata for interruption notice
# When detected, saves state and notifies before termination

set -euo pipefail

METADATA_URL="http://169.254.169.254/latest/meta-data/spot/instance-action"
TOKEN_URL="http://169.254.169.254/latest/api/token"
CHECK_INTERVAL=5  # seconds between checks
CURL_TIMEOUT=5    # seconds for metadata requests
DOCKER_TIMEOUT=30 # seconds for container stop
LOG_FILE="/var/log/spot-interruption-handler.log"
STATE_DIR="/home/ubuntu/.cache/spot-handler"
STATE_FILE="$STATE_DIR/interruption-state.json"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

mkdir -p "$STATE_DIR"

# Get IMDSv2 token (with timeout)
get_token() {
    curl -s -m "$CURL_TIMEOUT" -X PUT "$TOKEN_URL" \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || echo ""
}

# Check for spot interruption notice (with timeout)
check_interruption() {
    local token="$1"
    local response http_code

    # Use -w to get HTTP status code, -o to capture body
    http_code=$(curl -s -m "$CURL_TIMEOUT" -o /tmp/spot-response -w "%{http_code}" \
        -H "X-aws-ec2-metadata-token: $token" "$METADATA_URL" 2>/dev/null || echo "000")
    response=$(cat /tmp/spot-response 2>/dev/null || echo "")
    rm -f /tmp/spot-response

    # 200 = interruption notice present, 404 = no notice, 000 = timeout/error
    if [[ "$http_code" == "200" && -n "$response" ]]; then
        echo "$response"
        return 0
    elif [[ "$http_code" == "000" ]]; then
        log "Warning: Metadata service timeout or unreachable"
    fi
    return 1
}

# Save tmux sessions (returns 0 on success, 1 on failure)
save_tmux() {
    log "Saving tmux sessions..."

    # Run as ubuntu user
    if sudo -u ubuntu bash -c 'command -v tmux &>/dev/null && tmux list-sessions &>/dev/null'; then
        # Force resurrect save
        local resurrect_save="/home/ubuntu/.tmux/plugins/tmux-resurrect/scripts/save.sh"
        if [[ -x "$resurrect_save" ]]; then
            if sudo -u ubuntu bash -c "TMUX='' $resurrect_save" 2>/dev/null; then
                log "  ✓ tmux sessions saved via resurrect"
                return 0
            else
                log "  ✗ tmux resurrect save failed"
                return 1
            fi
        else
            log "  - tmux-resurrect not installed, skipping"
            return 0  # Not a failure if resurrect isn't installed
        fi
    else
        log "  - No tmux sessions running"
        return 0  # Not a failure if no sessions
    fi
}

# Stash uncommitted git changes (returns 0 on success, 1 on failure)
save_git() {
    log "Stashing uncommitted git changes..."

    local stashed=0
    local failed=0
    for dir in /home/ubuntu/code/*/ /home/ubuntu/projects/*/ /data/work/repos/*/ /data/home/repos/*/; do
        [[ -d "$dir/.git" ]] || continue

        local repo_name
        repo_name=$(basename "$dir")
        if [[ -n $(sudo -u ubuntu git -C "$dir" status --porcelain 2>/dev/null) ]]; then
            local stash_msg
            stash_msg="spot-interruption-$(date +%Y%m%d-%H%M%S)"
            if sudo -u ubuntu git -C "$dir" stash push -m "$stash_msg" 2>/dev/null; then
                log "  ✓ Stashed changes in $repo_name"
                ((stashed++))
            else
                log "  ✗ Failed to stash $repo_name"
                ((failed++))
            fi
        fi
    done

    [[ $stashed -eq 0 ]] && log "  - No uncommitted changes to stash"
    [[ $failed -gt 0 ]] && return 1
    return 0
}

# Stop Docker containers gracefully (returns 0 on success, 1 on failure)
save_docker() {
    log "Saving Docker state..."

    # Check if docker is available and responsive (with timeout)
    if ! timeout 5 docker info &>/dev/null; then
        log "  - Docker not available or not responding"
        return 0  # Not a failure if docker isn't running
    fi

    local containers
    containers=$(timeout 5 docker ps -q 2>/dev/null | wc -l)

    if [[ $containers -gt 0 ]]; then
        log "  Stopping $containers container(s) (timeout: ${DOCKER_TIMEOUT}s)..."
        # Stop with timeout, then force-kill any remaining
        if timeout $((DOCKER_TIMEOUT + 10)) docker ps -q | xargs -r docker stop --time "$DOCKER_TIMEOUT" 2>/dev/null; then
            log "  ✓ Stopped $containers container(s) gracefully"
            return 0
        else
            log "  ⚠ Graceful stop failed, force-killing..."
            docker ps -q | xargs -r docker kill 2>/dev/null || true
            log "  ✓ Force-killed remaining containers"
            return 0
        fi
    else
        log "  - No running containers"
        return 0
    fi
}

# Sync filesystems (returns 0 on success, 1 on failure)
sync_filesystems() {
    log "Syncing filesystems..."
    if sync; then
        log "  ✓ Filesystem sync complete"
        return 0
    else
        log "  ✗ Filesystem sync failed"
        return 1
    fi
}

# Send notification (SNS topic from Terraform)
send_notification() {
    local action_time="$1"

    log "Sending notification..."

    # Try to get instance ID and SNS topic from instance tags or environment
    local instance_id
    local token
    token=$(get_token)
    instance_id=$(curl -s -m "$CURL_TIMEOUT" -H "X-aws-ec2-metadata-token: $token" \
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

# Write state file (atomic write to prevent partial reads)
write_state() {
    local state="$1"
    local tmp_file="$STATE_FILE.tmp"
    echo "$state" > "$tmp_file"
    mv "$tmp_file" "$STATE_FILE"
}

# Main interruption handler
handle_interruption() {
    local action_info="$1"

    # Prevent running twice - check if already completed
    if [[ -f "$STATE_FILE" ]]; then
        local completed
        completed=$(jq -r '.completed_at // empty' "$STATE_FILE" 2>/dev/null || echo "")
        if [[ -n "$completed" ]]; then
            log "Interruption already handled at $completed, skipping"
            return 0
        fi
        log "Previous handler incomplete, retrying..."
    fi

    local action_time started_at
    action_time=$(echo "$action_info" | jq -r '.time // "unknown"' 2>/dev/null || echo "unknown")
    started_at=$(date -Iseconds)

    log "=========================================="
    log "SPOT INTERRUPTION NOTICE RECEIVED"
    log "Termination time: $action_time"
    log "=========================================="

    # Track operation results
    local completed_ops=()
    local failed_ops=()

    # Run all save operations, tracking results
    if save_tmux; then
        completed_ops+=("tmux")
    else
        failed_ops+=("tmux")
    fi

    if save_git; then
        completed_ops+=("git")
    else
        failed_ops+=("git")
    fi

    if save_docker; then
        completed_ops+=("docker")
    else
        failed_ops+=("docker")
    fi

    if sync_filesystems; then
        completed_ops+=("filesystem")
    else
        failed_ops+=("filesystem")
    fi

    # Send notification (don't fail handler if notification fails)
    send_notification "$action_time" || true
    completed_ops+=("notification")

    local completed_at
    completed_at=$(date -Iseconds)

    # Write state file AFTER all operations complete (atomic)
    local state
    state=$(jq -n \
        --arg started "$started_at" \
        --arg completed "$completed_at" \
        --arg action_time "$action_time" \
        --argjson completed_ops "$(printf '%s\n' "${completed_ops[@]}" | jq -R . | jq -s .)" \
        --argjson failed_ops "$(printf '%s\n' "${failed_ops[@]:-}" | jq -R . | jq -s .)" \
        '{
            started_at: $started,
            completed_at: $completed,
            action_time: $action_time,
            completed_operations: $completed_ops,
            failed_operations: $failed_ops
        }')
    write_state "$state"

    log "=========================================="
    log "STATE PRESERVATION COMPLETE"
    log "Completed: ${completed_ops[*]}"
    [[ ${#failed_ops[@]} -gt 0 ]] && log "Failed: ${failed_ops[*]}"
    log "Instance will terminate at: $action_time"
    log "=========================================="
}

# Main monitoring loop
main() {
    log "Spot interruption handler started"
    log "Checking metadata every ${CHECK_INTERVAL}s..."

    # Clean up incomplete state file on fresh start (keep completed ones for debugging)
    if [[ -f "$STATE_FILE" ]]; then
        local completed
        completed=$(jq -r '.completed_at // empty' "$STATE_FILE" 2>/dev/null || echo "")
        if [[ -z "$completed" ]]; then
            log "Removing incomplete state file from previous run"
            rm -f "$STATE_FILE"
        fi
    fi

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
