#!/bin/bash
# setup-pai-volumes.sh — Initialize PAI named Docker volumes
#
# Creates pai-config and pai-memory volumes and populates them
# from the current ~/.claude directory on the host.
#
# Run ONCE on initial setup, or to re-sync config into volumes.
# Safe to re-run: existing volumes are not destroyed.
#
# Volume layout:
#   pai-config  (read-only in containers) — all of ~/.claude except MEMORY/
#   pai-memory  (read-write in containers) — ~/.claude/MEMORY/ only
#
# After running this script, start a session with:
#   scripts/pai-session start default

set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"
HELPER_IMAGE="alpine:latest"

echo "=== PAI Volume Setup ==="
echo ""

# ── Create volumes ──────────────────────────────────────────────────────────

for vol in pai-config pai-memory; do
    if docker volume inspect "${vol}" &>/dev/null; then
        echo "✓ Volume '${vol}' already exists"
    else
        docker volume create "${vol}"
        echo "✓ Created volume '${vol}'"
    fi
done

echo ""

# ── Populate pai-config (all of ~/.claude except MEMORY/) ──────────────────

echo "Populating pai-config from ${CLAUDE_DIR} (excluding MEMORY/)..."
docker run --rm \
    --mount "type=bind,src=${CLAUDE_DIR},dst=/src,readonly" \
    --mount "type=volume,src=pai-config,dst=/dst" \
    "${HELPER_IMAGE}" \
    sh -c "
        # Copy everything except MEMORY/
        cd /src
        find . -mindepth 1 -maxdepth 1 ! -name 'MEMORY' | while read item; do
            cp -r \"\$item\" /dst/
        done
        echo 'Done copying config files'
        ls /dst/ | head -20
    "
echo "✓ pai-config populated"

# Create MEMORY mountpoint dir in pai-config (required for nested volume overlay at runtime)
docker run --rm \
    --mount "type=volume,src=pai-config,dst=/dst" \
    "${HELPER_IMAGE}" \
    sh -c "mkdir -p /dst/MEMORY && echo 'Created MEMORY mountpoint'"
echo "✓ MEMORY mountpoint created in pai-config"
echo ""

# ── Populate pai-memory (only ~/.claude/MEMORY/) ────────────────────────────

if [[ -d "${CLAUDE_DIR}/MEMORY" ]]; then
    echo "Populating pai-memory from ${CLAUDE_DIR}/MEMORY/..."
    docker run --rm \
        --mount "type=bind,src=${CLAUDE_DIR}/MEMORY,dst=/src,readonly" \
        --mount "type=volume,src=pai-memory,dst=/dst" \
        "${HELPER_IMAGE}" \
        sh -c "
            cp -r /src/. /dst/
            echo 'Done copying MEMORY files'
            ls /dst/ | head -20
        "
    echo "✓ pai-memory populated"
else
    echo "⚠ ${CLAUDE_DIR}/MEMORY not found — pai-memory will be empty (ok for fresh install)"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Pull the PAI image:  docker pull ghcr.io/sethdf/imladris/pai:latest"
echo "  2. Start a session:     scripts/pai-session start default"
echo "  3. Attach:              scripts/pai-session attach default"
echo ""
echo "To update config volume after ~/.claude changes:"
echo "  docker run --rm -v ~/.claude:/src:ro -v pai-config:/dst alpine sh -c 'cp -r /src/. /dst/ --exclude=MEMORY'"
