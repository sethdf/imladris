#!/usr/bin/env bash
# =============================================================================
# sync-aurora-credentials.sh — Retrieve ElevenLabs API key from BWS via EC2
# =============================================================================
# BWS (Bitwarden Secrets) is installed on the EC2 instance (imladris-4), not
# on Aurora. This script SSHs to EC2 to retrieve the secret and writes it to
# the local PAI env file.
#
# Usage:
#   ./sync-aurora-credentials.sh              # Default: SSH to imladris-4
#   SSH_HOST=imladris-4 ./sync-aurora-credentials.sh  # Custom host
#
# Prerequisites:
#   - SSH access to EC2 via Tailscale (imladris-4)
#   - BWS configured on EC2 with access token
#   - jq installed locally

set -euo pipefail

SSH_HOST="${SSH_HOST:-imladris-4}"
SSH_USER="${SSH_USER:-ec2-user}"
BWS_SECRET_ID="35695819-45c5-4667-8afa-b3f50139886c"
ENV_DIR="${HOME}/.config/PAI"
ENV_FILE="${ENV_DIR}/.env"

echo "Syncing credentials from BWS via ${SSH_USER}@${SSH_HOST}..."

# Retrieve the ElevenLabs API key from BWS on EC2
KEY=$(ssh "${SSH_USER}@${SSH_HOST}" \
  "bws secret get ${BWS_SECRET_ID} 2>/dev/null" \
  | jq -r '.value // empty')

if [ -z "${KEY}" ]; then
  echo "ERROR: Failed to retrieve ElevenLabs API key from BWS"
  echo "  Host: ${SSH_USER}@${SSH_HOST}"
  echo "  Secret ID: ${BWS_SECRET_ID}"
  echo ""
  echo "Ensure BWS is configured on ${SSH_HOST}:"
  echo "  ssh ${SSH_USER}@${SSH_HOST} 'bws secret get ${BWS_SECRET_ID}'"
  exit 1
fi

# Write to env file
mkdir -p "${ENV_DIR}"
echo "ELEVENLABS_API_KEY=${KEY}" > "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

# Create ~/.env symlink if it doesn't exist or points elsewhere
if [ ! -L "${HOME}/.env" ] || [ "$(readlink -f "${HOME}/.env")" != "$(readlink -f "${ENV_FILE}")" ]; then
  ln -sf "${ENV_FILE}" "${HOME}/.env"
  echo "Created symlink: ~/.env → ${ENV_FILE}"
fi

echo "Credentials synced to ${ENV_FILE} (mode 600)"
echo "API key: ${KEY:0:8}...${KEY: -4}"
