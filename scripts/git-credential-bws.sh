#!/usr/bin/env bash
# Git credential helper that reads GitHub PAT from Bitwarden Secrets Manager (BWS).
# Configured via: git config --global credential.helper '/path/to/git-credential-bws.sh'
#
# Expects BWS_ACCESS_TOKEN in environment (set in .bashrc or systemd env).
# BWS secret key: github-token (ID: 9b8accb0-d4f8-4eb0-b4ed-b3d20126389d)

set -euo pipefail

# Only handle "get" operations
if [ "${1:-}" != "get" ]; then
  exit 0
fi

# Read stdin to check if this is a github.com request
HOST=""
while IFS='=' read -r key value; do
  case "$key" in
    host) HOST="$value" ;;
  esac
done

if [ "$HOST" != "github.com" ]; then
  exit 0
fi

# Fetch token from BWS
if [ -z "${BWS_ACCESS_TOKEN:-}" ]; then
  # Try loading from .bashrc
  source "$HOME/.bashrc" 2>/dev/null || true
fi

if [ -z "${BWS_ACCESS_TOKEN:-}" ]; then
  echo "git-credential-bws: BWS_ACCESS_TOKEN not set" >&2
  exit 1
fi

TOKEN=$(bws secret get 9b8accb0-d4f8-4eb0-b4ed-b3d20126389d 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['value'])" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "git-credential-bws: Failed to fetch github-token from BWS" >&2
  exit 1
fi

echo "protocol=https"
echo "host=github.com"
echo "username=x-access-token"
echo "password=$TOKEN"
