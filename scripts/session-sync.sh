#!/bin/bash
#
# session-sync.sh - Real-time git sync for session files
#
# Watches a directory for changes and automatically commits/pushes to git.
# Designed for backing up AI session data, notes, and other frequently-changing files.
#
# Usage:
#   session-sync.sh <directory> [branch]
#
# Examples:
#   session-sync.sh ~/sessions/home main
#   session-sync.sh ~/sessions/work main
#
# The directory must already be a git repo with a remote configured.

set -euo pipefail

WATCH_DIR="${1:-}"
BRANCH="${2:-main}"
DEBOUNCE_SECONDS=30  # Wait this long after last change before committing
BATCH_WINDOW=5       # Collect changes for this many seconds before commit

if [[ -z "$WATCH_DIR" ]]; then
    echo "Usage: $0 <directory> [branch]"
    exit 1
fi

if [[ ! -d "$WATCH_DIR/.git" ]]; then
    echo "Error: $WATCH_DIR is not a git repository"
    exit 1
fi

cd "$WATCH_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# Check for required tools
if ! command -v inotifywait &>/dev/null; then
    echo "Error: inotifywait not found. Install with: sudo apt install inotify-tools"
    exit 1
fi

# Ensure we're on the right branch
git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH"

log "Starting session-sync for $WATCH_DIR on branch $BRANCH"
log "Debounce: ${DEBOUNCE_SECONDS}s, Batch window: ${BATCH_WINDOW}s"

# Track pending changes state
pending_changes=false

sync_changes() {
    # Stage all changes
    git add -A

    # Check if there's anything to commit
    if git diff --cached --quiet; then
        return 0
    fi

    # Get summary of changes
    local added
    added=$(git diff --cached --numstat | wc -l)
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    # Commit with timestamp
    git commit -q -m "Auto-sync: $timestamp" -m "Files changed: $added"

    # Push (with retry)
    local retries=3
    for ((i=1; i<=retries; i++)); do
        if git push -q origin "$BRANCH" 2>/dev/null; then
            log "Synced $added file(s) to origin/$BRANCH"
            return 0
        fi

        if [[ $i -lt $retries ]]; then
            log "Push failed, retrying in ${i}s..."
            sleep "$i"
            git pull -q --rebase origin "$BRANCH" 2>/dev/null || true
        fi
    done

    log "Warning: Push failed after $retries attempts. Changes committed locally."
    return 1
}

# Handle graceful shutdown
cleanup() {
    log "Shutting down, syncing final changes..."
    sync_changes || true
    exit 0
}
trap cleanup SIGTERM SIGINT

# Main loop using inotifywait in monitor mode
log "Watching for changes..."

inotifywait -m -r -q \
    --exclude '\.git' \
    -e modify -e create -e delete -e move \
    "$WATCH_DIR" |
while read -r _directory event filename; do
    # Skip git internal files
    [[ "$filename" == .git* ]] && continue

    if [[ "$pending_changes" == false ]]; then
        # First change in a batch - start the timer
        pending_changes=true
        log "Change detected: $filename ($event)"

        # Background process to handle debounced sync
        (
            sleep "$DEBOUNCE_SECONDS"
            # Signal main process that debounce period is over
            # We do this by touching a trigger file
            touch "$WATCH_DIR/.git/.sync-trigger" 2>/dev/null || true
        ) &
    fi
done &

INOTIFY_PID=$!

# Monitor for sync triggers
while true; do
    if [[ -f "$WATCH_DIR/.git/.sync-trigger" ]]; then
        rm -f "$WATCH_DIR/.git/.sync-trigger"
        if [[ "$pending_changes" == true ]]; then
            sync_changes || true
            pending_changes=false
        fi
    fi
    sleep 1
done &

wait $INOTIFY_PID
