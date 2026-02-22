#!/usr/bin/env bash
set -euo pipefail

# Tailscale setup for Imladris cloud workstation
# Decision 33: Tailscale-only network. Zero public inbound ports.
#
# Usage: ./setup.sh <tailscale-auth-key>
# Idempotent — safe to run multiple times.

AUTH_KEY="${1:-}"

if [[ -z "${AUTH_KEY}" ]]; then
  echo "ERROR: Tailscale auth key required as first argument."
  echo "Usage: $0 <tailscale-auth-key>"
  exit 1
fi

# --- Install Tailscale if not present ---
if command -v tailscale &>/dev/null; then
  echo "Tailscale is already installed: $(tailscale version | head -1)"
else
  echo "Installing Tailscale via dnf..."
  sudo dnf install -y tailscale
  echo "Tailscale installed."
fi

# --- Enable and start tailscaled ---
if systemctl is-active --quiet tailscaled; then
  echo "tailscaled service is already running."
else
  echo "Enabling and starting tailscaled..."
  sudo systemctl enable --now tailscaled
  echo "tailscaled service started."
fi

# --- Enroll node with auth key and enable SSH ---
echo "Enrolling node with Tailscale (SSH enabled)..."
sudo tailscale up --authkey="${AUTH_KEY}" --ssh

echo ""
echo "--- Tailscale Status ---"
tailscale status
echo ""
echo "Tailscale IP: $(tailscale ip -4)"
echo "Setup complete. All services should bind to 127.0.0.1 and be accessed via Tailscale only."
