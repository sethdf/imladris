#!/bin/bash
# PAI session container entrypoint
# Starts or re-attaches to a tmux session named 'main'
set -e

SESSION="main"

# Start tmux server if not running
tmux start-server 2>/dev/null || true

if tmux has-session -t "${SESSION}" 2>/dev/null; then
    # Session exists — attach
    exec tmux attach-session -t "${SESSION}"
else
    # New session — create and attach
    exec tmux new-session -s "${SESSION}"
fi
