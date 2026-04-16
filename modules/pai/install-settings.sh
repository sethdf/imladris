#!/usr/bin/env bash
# Render settings.json.template -> ~/.claude/settings.json
# Pulls secrets from BWS (or env overrides) and envsubsts the template.
# Refuses to overwrite an existing ~/.claude/settings.json unless --force is given.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/settings.json.template"
TARGET="${HOME}/.claude/settings.json"
FORCE="${1:-}"

[ -f "$TEMPLATE" ] || { echo "missing template: $TEMPLATE" >&2; exit 1; }

if [ -f "$TARGET" ] && [ "$FORCE" != "--force" ]; then
  echo "refusing to overwrite existing $TARGET (pass --force to replace)" >&2
  exit 2
fi

# Secrets — prefer env var, fall back to BWS.
load_secret() {
  local var="$1" bws_key="$2"
  if [ -n "${!var:-}" ]; then return 0; fi
  if command -v bws >/dev/null 2>&1; then
    local val
    val="$(bws secret list 2>/dev/null | awk -v k="$bws_key" -F'|' '$2 ~ k {print $3; exit}' || true)"
    if [ -n "$val" ]; then export "$var=$val"; return 0; fi
  fi
  echo "missing secret for $var (set env or create BWS key $bws_key)" >&2
  return 1
}

load_secret WINDMILL_TOKEN_IMLADRIS windmill-token-imladris
load_secret WINDMILL_TOKEN_PALANTIR windmill-token-palantir
load_secret SLACK_BOT_TOKEN         slack-bot-token
load_secret SLACK_TEAM_ID           slack-team-id

mkdir -p "$(dirname "$TARGET")"
envsubst < "$TEMPLATE" > "$TARGET"
chmod 600 "$TARGET"
echo "wrote $TARGET"
