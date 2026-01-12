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

TRIGGER_FILE="$WATCH_DIR/.git/.sync-trigger"
PENDING_FILE="$WATCH_DIR/.git/.sync-pending"

# Clean up any stale state
rm -f "$TRIGGER_FILE" "$PENDING_FILE"

# Start inotifywait in background, writing events to a pipe
inotifywait -m -r -q \
    --exclude '\.git' \
    -e modify -e create -e delete -e move \
    "$WATCH_DIR" |
while read -r _directory event filename; do
    # Skip git internal files
    [[ "$filename" == .git* ]] && continue

    # Check if we already have a pending sync scheduled
    if [[ ! -f "$PENDING_FILE" ]]; then
        # First change in a batch - mark as pending and start timer
        touch "$PENDING_FILE"
        log "Change detected: $filename ($event)"

        # Background process to handle debounced sync
        (
            sleep "$DEBOUNCE_SECONDS"
            # Signal that debounce period is over
            touch "$TRIGGER_FILE" 2>/dev/null || true
        ) &
    fi
done &

INOTIFY_PID=$!

# Monitor for sync triggers in main process
while kill -0 $INOTIFY_PID 2>/dev/null; do
    if [[ -f "$TRIGGER_FILE" ]]; then
        rm -f "$TRIGGER_FILE" "$PENDING_FILE"
        sync_changes || true
    fi
    sleep 1
done

# Final cleanup
rm -f "$TRIGGER_FILE" "$PENDING_FILE"
