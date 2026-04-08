#!/bin/bash
# setup-pai-volumes.sh — Initialize PAI Docker volumes and host bind mounts
#
# Creates pai-config named volume and /pai/memory host directory,
# and populates them from the current ~/.claude directory on the host.
#
# Run ONCE on initial setup, or to re-sync config into volumes.
# Safe to re-run: existing volumes and directories are not destroyed.
#
# Layout:
#   pai-config   (Docker named volume, read-only in containers)
#                 — all of ~/.claude except MEMORY/
#   /pai/memory  (host bind mount, read-write in containers)
#                 — ~/.claude/MEMORY/ — on EBS root volume (persistent across stop/start)
#
# Why /pai/memory is a bind mount (not named volume):
#   Docker named volumes are stored in docker data-root (/local/docker on NVMe —
#   ephemeral instance store). MEMORY files must survive instance stop/start on EBS.
#   The host daemon (pai-sync-daemon) also needs a stable host path to watch.
#
# After running this script, start a session with:
#   scripts/pai-session start default

set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"
PAI_MEMORY_DIR="/pai/memory"
PAI_INBOX_DIR="/pai/inbox"
PAI_OUTBOX_DIR="/pai/outbox"
HELPER_IMAGE="alpine:latest"

echo "=== PAI Volume Setup ==="
echo ""

# ── Create pai-config named volume ─────────────────────────────────────────

if docker volume inspect pai-config &>/dev/null; then
    echo "✓ Volume 'pai-config' already exists"
else
    docker volume create pai-config
    echo "✓ Created volume 'pai-config'"
fi

echo ""

# ── Create /pai/memory host directory (EBS-backed, persistent) ─────────────

if [[ -d "${PAI_MEMORY_DIR}" ]]; then
    echo "✓ Host directory ${PAI_MEMORY_DIR} already exists"
else
    echo "Creating ${PAI_MEMORY_DIR}..."
    sudo mkdir -p "${PAI_MEMORY_DIR}"
    sudo chown "${USER}:${USER}" "${PAI_MEMORY_DIR}"
    echo "✓ Created ${PAI_MEMORY_DIR} (owned by ${USER})"
fi

# ── Migrate from pai-memory named volume if it exists ──────────────────────

if docker volume inspect pai-memory &>/dev/null; then
    # Check if /pai/memory is already populated
    if [[ -z "$(ls -A "${PAI_MEMORY_DIR}" 2>/dev/null)" ]]; then
        echo "Migrating pai-memory Docker volume → ${PAI_MEMORY_DIR}..."
        docker run --rm \
            --mount "type=volume,src=pai-memory,dst=/src,readonly" \
            --mount "type=bind,src=${PAI_MEMORY_DIR},dst=/dst" \
            "${HELPER_IMAGE}" \
            sh -c "cp -r /src/. /dst/ && echo 'Migration done' && ls /dst/ | head -20"
        echo "✓ Migrated pai-memory → ${PAI_MEMORY_DIR}"
        echo "  (pai-memory Docker volume still exists — remove with: docker volume rm pai-memory)"
    else
        echo "⚠ ${PAI_MEMORY_DIR} is not empty — skipping migration from pai-memory volume"
    fi
fi

echo ""

# ── Populate pai-config (all of ~/.claude except MEMORY/) ──────────────────

echo "Populating pai-config from ${CLAUDE_DIR} (excluding MEMORY/)..."
docker run --rm \
    --mount "type=bind,src=${CLAUDE_DIR},dst=/src,readonly" \
    --mount "type=volume,src=pai-config,dst=/dst" \
    "${HELPER_IMAGE}" \
    sh -c "
        cd /src
        find . -mindepth 1 -maxdepth 1 ! -name 'MEMORY' | while read item; do
            cp -r \"\$item\" /dst/
        done
        echo 'Done copying config files'
        ls /dst/ | head -20
    "
echo "✓ pai-config populated"

# Create MEMORY mountpoint dir in pai-config (required for bind mount overlay)
docker run --rm \
    --mount "type=volume,src=pai-config,dst=/dst" \
    "${HELPER_IMAGE}" \
    sh -c "mkdir -p /dst/MEMORY && echo 'Created MEMORY mountpoint'"
echo "✓ MEMORY mountpoint created in pai-config"
echo ""

# ── Populate /pai/memory from ~/.claude/MEMORY/ (if empty) ─────────────────

if [[ -z "$(ls -A "${PAI_MEMORY_DIR}" 2>/dev/null)" ]]; then
    if [[ -d "${CLAUDE_DIR}/MEMORY" ]]; then
        echo "Populating ${PAI_MEMORY_DIR} from ${CLAUDE_DIR}/MEMORY/..."
        cp -r "${CLAUDE_DIR}/MEMORY/." "${PAI_MEMORY_DIR}/"
        echo "✓ ${PAI_MEMORY_DIR} populated"
    else
        echo "⚠ ${CLAUDE_DIR}/MEMORY not found — ${PAI_MEMORY_DIR} will be empty (ok for fresh install)"
    fi
else
    echo "✓ ${PAI_MEMORY_DIR} already has content — skipping initial population"
fi

# Ensure node user (uid 1000) can write — relevant when containers write back
# Host daemon runs as ec2-user so no ownership change needed for daemon reads

# ── Create inbox/outbox directories (Windmill<->PAI filesystem queue) ─────

echo ""
echo "--- Inbox/Outbox Setup ---"

for dir in "${PAI_INBOX_DIR}" "${PAI_OUTBOX_DIR}"; do
    if [[ -d "${dir}" ]]; then
        echo "  Host directory ${dir} already exists"
    else
        echo "Creating ${dir}..."
        sudo mkdir -p "${dir}"
        sudo chown "${USER}:${USER}" "${dir}"
        chmod 770 "${dir}"
        echo "  Created ${dir} (owned by ${USER}, mode 770)"
    fi
done

# Processed subdirectory: inbox jobs move here after PAI reads them
[[ -d "${PAI_INBOX_DIR}/processed" ]] || mkdir -p "${PAI_INBOX_DIR}/processed"
echo "  ${PAI_INBOX_DIR}/processed/ ready"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Pull the PAI image:  docker pull ghcr.io/sethdf/imladris/pai:latest"
echo "  2. Start a session:     scripts/pai-session start default"
echo "  3. Attach:              scripts/pai-session attach default"
echo ""
echo "Directories:"
echo "  pai-config volume  : Claude config (ro in containers)"
echo "  ${PAI_MEMORY_DIR}  : MEMORY files (rw, EBS-backed)"
echo "  ${PAI_INBOX_DIR}   : Windmill -> PAI job requests"
echo "  ${PAI_OUTBOX_DIR}  : PAI -> Windmill job results"
echo ""
echo "  pai-sync-daemon watches: ${PAI_MEMORY_DIR}"
echo "  To start sync daemon:    systemctl start pai-sync"
