#!/bin/bash
# PAI session container entrypoint
# Creates a detached tmux session 'main' and keeps the container alive.
# Users attach via: docker exec -it pai-{name} tmux attach -t main
set -e

SESSION="main"

# Start tmux server
tmux start-server 2>/dev/null || true

# Create the session if it doesn't exist (detached — we're the PID 1 keepalive)
if ! tmux has-session -t "${SESSION}" 2>/dev/null; then
    tmux new-session -d -s "${SESSION}"
fi

echo "PAI session container ready. tmux session '${SESSION}' created."
echo "Attach with: docker exec -it \$(hostname) tmux attach -t ${SESSION}"

# Keep container alive by waiting on the tmux server process.
# When tmux server exits (all sessions killed), the container stops.
exec tmux wait-for pai-shutdown
