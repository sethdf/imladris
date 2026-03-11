#!/usr/bin/env bash
# =============================================================================
# setup.sh — Create Python venv and install voice-listener dependencies
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/venv"

echo "Setting up voice-listener at ${SCRIPT_DIR}..."

# Create venv if it doesn't exist
if [ ! -d "${VENV_DIR}" ]; then
  echo "Creating Python venv..."
  python3 -m venv "${VENV_DIR}"
fi

# Upgrade pip and install dependencies
echo "Installing dependencies..."
"${VENV_DIR}/bin/pip" install --upgrade pip -q
"${VENV_DIR}/bin/pip" install -r "${SCRIPT_DIR}/requirements.txt" -q

# Download openwakeword models on first run
echo "Pre-downloading wake word models..."
"${VENV_DIR}/bin/python3" -c "
from openwakeword.model import Model
m = Model()
print(f'Models loaded: {list(m.models.keys())}')
" 2>/dev/null

echo ""
echo "Setup complete. Run with:"
echo "  ${VENV_DIR}/bin/python3 ${SCRIPT_DIR}/voice-listener.py"
