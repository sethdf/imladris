#!/bin/bash
# devbox-restore - Restore development environment on login
# Source this from .zshrc or run manually

set -euo pipefail

CACHE_DIR="$HOME/.cache/devbox"
LAST_DIR_FILE="$CACHE_DIR/last-working-dir"
DOCKER_PROJECTS_FILE="$HOME/.config/devbox/docker-projects.txt"
RESTORE_LOG="$CACHE_DIR/restore.log"

mkdir -p "$CACHE_DIR" "$HOME/.config/devbox"

log() {
    echo "[$(date '+%H:%M:%S')] $*" >> "$RESTORE_LOG"
}

# ============================================================================
# Status Display
# ============================================================================
show_status() {
    local bw_status docker_status luks_status

    # Bitwarden status
    if [[ -n "${BW_SESSION:-}" ]] && bw status 2>/dev/null | grep -q '"status":"unlocked"'; then
        bw_status="✓ unlocked"
    else
        bw_status="✗ locked (run: unlock)"
    fi

    # Docker status
    local container_count
    container_count=$(docker ps -q 2>/dev/null | wc -l)
    docker_status="$container_count running"

    # LUKS/Home status
    if mountpoint -q /home 2>/dev/null; then
        luks_status="✓ mounted"
    else
        luks_status="✗ not mounted"
    fi

    echo "┌─────────────────────────────────────┐"
    echo "│          DevBox Status              │"
    echo "├─────────────────────────────────────┤"
    printf "│  Bitwarden: %-23s│\n" "$bw_status"
    printf "│  Docker:    %-23s│\n" "$docker_status"
    printf "│  /home:     %-23s│\n" "$luks_status"
    echo "└─────────────────────────────────────┘"
}

# ============================================================================
# Docker Restore
# ============================================================================
restore_docker_projects() {
    [[ -f "$DOCKER_PROJECTS_FILE" ]] || return 0

    local restored=0
    while IFS= read -r compose_file || [[ -n "$compose_file" ]]; do
        # Skip comments and empty lines
        [[ "$compose_file" =~ ^#.*$ || -z "$compose_file" ]] && continue

        if [[ -f "$compose_file" ]]; then
            log "Starting docker-compose: $compose_file"
            docker compose -f "$compose_file" up -d 2>/dev/null && ((restored++))
        fi
    done < "$DOCKER_PROJECTS_FILE"

    [[ $restored -gt 0 ]] && echo "  Restored $restored Docker project(s)"
}

# ============================================================================
# Tmux Session Restore
# ============================================================================
restore_tmux_session() {
    # Only in interactive SSH sessions, not already in tmux
    [[ -z "${TMUX:-}" && -n "${SSH_CONNECTION:-}" ]] || return 0

    if tmux has-session -t main 2>/dev/null; then
        echo "  Attaching to existing tmux session..."
        exec tmux attach -t main
    else
        echo "  Creating new tmux session..."
        # Restore last directory if available
        local start_dir="$HOME"
        [[ -f "$LAST_DIR_FILE" ]] && start_dir=$(cat "$LAST_DIR_FILE")
        exec tmux new -s main -c "$start_dir"
    fi
}

# ============================================================================
# Directory Tracking (call from chpwd hook)
# ============================================================================
save_last_dir() {
    echo "$PWD" > "$LAST_DIR_FILE"
}

# ============================================================================
# Git Status Summary
# ============================================================================
check_git_repos() {
    local repos_with_changes=()

    for dir in ~/code/*/ ~/projects/*/; do
        [[ -d "$dir/.git" ]] || continue
        if [[ -n $(git -C "$dir" status --porcelain 2>/dev/null) ]]; then
            repos_with_changes+=("$(basename "$dir")")
        fi
    done

    if [[ ${#repos_with_changes[@]} -gt 0 ]]; then
        echo "  ⚠ Uncommitted changes in: ${repos_with_changes[*]}"
    fi
}

# ============================================================================
# Main Restore Flow
# ============================================================================
main() {
    log "=== DevBox restore started ==="

    echo ""
    show_status
    echo ""

    # Restore Docker projects (background)
    restore_docker_projects &

    # Check for uncommitted work
    check_git_repos

    # Wait for background tasks
    wait

    echo ""

    # Finally, attach to tmux (this execs, so must be last)
    restore_tmux_session
}

# ============================================================================
# Zsh Integration Hooks
# ============================================================================

# Export functions for zsh hooks
typeset -f save_last_dir > /dev/null 2>&1 && export -f save_last_dir

# If sourced with "status" argument, just show status
case "${1:-}" in
    status)
        show_status
        ;;
    docker)
        restore_docker_projects
        ;;
    git)
        check_git_repos
        ;;
    *)
        main
        ;;
esac
