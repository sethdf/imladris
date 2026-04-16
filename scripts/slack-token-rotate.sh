#!/usr/bin/env bash
# =============================================================================
# slack-token-rotate.sh — Rotate + validate Slack user token in Windmill
# =============================================================================
# Subcommands:
#   check                 Audit the current token in Windmill against required scopes.
#   rotate                Read new token from stdin, validate scopes, write to Windmill.
#
# Usage:
#   scripts/slack-token-rotate.sh check
#   read -rs NEW && echo "$NEW" | scripts/slack-token-rotate.sh rotate
#   # or:
#   scripts/slack-token-rotate.sh rotate < /path/to/token.txt
#
# The token is read from stdin only — never from argv — so it does not land in
# shell history. Validation requires every scope in REQUIRED_SCOPES to be
# present; missing scopes abort the rotation with a clear message naming them.
#
# Windmill variables updated (in sync):
#   f/devops/slack_user_token
#   f/devops/slack_bot_token   (historical duplicate — kept in sync to avoid
#                               breaking anything still reading it)
#
# Prereqs:
#   - ~/.windmill/.env contains WINDMILL_ADMIN_SECRET=<secret>
#   - Windmill reachable at localhost:8000
#   - jq installed

set -euo pipefail

WINDMILL_URL="http://localhost:8000"
WINDMILL_WORKSPACE="imladris"
WINDMILL_ENV="$HOME/.windmill/.env"
VARS=(
  "f/devops/slack_user_token"
  "f/devops/slack_bot_token"
)

# --- Source of truth: scopes every rotation must preserve ---------------------
# If a future reauth drops any of these, rotate will fail and you'll know to
# re-add them in the Slack app config (api.slack.com/apps → OAuth & Permissions
# → User Token Scopes) before reinstalling.
REQUIRED_SCOPES=(
  # Pre-existing scopes (preserve)
  admin
  identify
  channels:history
  channels:read
  groups:history
  groups:read
  im:history
  im:read
  mpim:history
  mpim:read
  chat:write
  users:write
  # Added 2026-04-14 — approved scope expansion
  files:read
  users:read
  users:read.email
  reactions:read
  links:read
  search:read
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[info]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
error() { echo -e "${RED}[error]${NC} $*" >&2; }
note()  { echo -e "${BLUE}[note]${NC}  $*"; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { error "missing required command: $1"; exit 1; }
}

load_admin_secret() {
  if [ ! -f "$WINDMILL_ENV" ]; then
    error "Windmill env not found: $WINDMILL_ENV"
    exit 1
  fi
  # shellcheck disable=SC1090
  ADMIN_SECRET=$(grep -E '^WINDMILL_ADMIN_SECRET=' "$WINDMILL_ENV" | head -n1 | cut -d= -f2-)
  if [ -z "${ADMIN_SECRET:-}" ]; then
    error "WINDMILL_ADMIN_SECRET not set in $WINDMILL_ENV"
    exit 1
  fi
}

windmill_curl() {
  # usage: windmill_curl <method> <path> [body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" \
      -H "Authorization: Bearer $ADMIN_SECRET" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "$WINDMILL_URL/api/w/$WINDMILL_WORKSPACE$path"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer $ADMIN_SECRET" \
      "$WINDMILL_URL/api/w/$WINDMILL_WORKSPACE$path"
  fi
}

get_var_value() {
  # Windmill returns the decrypted value as a JSON-quoted string for secrets.
  windmill_curl GET "/variables/get_value/$1" | jq -r '.' 2>/dev/null || true
}

update_var_value() {
  local path="$1" value="$2"
  # Windmill expects: PUT /variables/update/{path} with JSON {"value": "..."}
  local body
  body=$(jq -n --arg v "$value" '{value: $v}')
  windmill_curl POST "/variables/update/$path" "$body" >/dev/null
}

# Pull the x-oauth-scopes header from auth.test and return comma-separated scopes.
slack_get_scopes() {
  local token="$1"
  local hdr
  hdr=$(curl -sS -D - -o /dev/null \
    -H "Authorization: Bearer $token" \
    "https://slack.com/api/auth.test" \
    | tr -d '\r' \
    | grep -i '^x-oauth-scopes:' \
    | head -n1 \
    | cut -d' ' -f2- || true)
  echo "$hdr"
}

slack_auth_test() {
  local token="$1"
  curl -sS -H "Authorization: Bearer $token" "https://slack.com/api/auth.test"
}

validate_scopes() {
  # stdin: comma-separated scopes
  # Sets MISSING_SCOPES (newline-separated) as a global.
  local actual="$1"
  MISSING_SCOPES=""
  # Normalize to newline list for fast membership check
  local actual_list
  actual_list=$(echo "$actual" | tr ',' '\n' | awk '{$1=$1; print}')
  for needed in "${REQUIRED_SCOPES[@]}"; do
    if ! grep -qx "$needed" <<< "$actual_list"; then
      MISSING_SCOPES+="  - $needed"$'\n'
    fi
  done
}

cmd_check() {
  load_admin_secret
  info "Fetching current token from Windmill variable ${VARS[0]}"
  local token
  token=$(get_var_value "${VARS[0]}")
  if [ -z "$token" ] || [ "$token" = "null" ]; then
    error "No current token found at ${VARS[0]}"
    exit 2
  fi
  local prefix="${token:0:5}"
  info "Token retrieved (prefix=$prefix, len=${#token})"

  info "Calling Slack auth.test"
  local auth
  auth=$(slack_auth_test "$token")
  local ok
  ok=$(echo "$auth" | jq -r '.ok')
  if [ "$ok" != "true" ]; then
    error "auth.test failed: $(echo "$auth" | jq -r '.error')"
    exit 3
  fi
  echo "$auth" | jq '{ok, team, user, team_id, user_id}'

  local scopes
  scopes=$(slack_get_scopes "$token")
  note "x-oauth-scopes: $scopes"

  validate_scopes "$scopes"
  if [ -z "$MISSING_SCOPES" ]; then
    info "All ${#REQUIRED_SCOPES[@]} required scopes present. Token is healthy."
    exit 0
  fi
  warn "Missing required scopes:"
  printf "%s" "$MISSING_SCOPES"
  echo
  note "Fix: add these scopes at https://api.slack.com/apps → OAuth & Permissions"
  note "     → User Token Scopes, then Reinstall to Workspace."
  exit 4
}

cmd_rotate() {
  require_cmd jq
  load_admin_secret

  if [ -t 0 ]; then
    error "No token on stdin. Usage:"
    error "  read -rs TOK && printf '%s' \"\$TOK\" | $0 rotate"
    exit 1
  fi

  local new_token
  new_token=$(cat | tr -d '\r\n ')
  if [ -z "$new_token" ]; then
    error "Empty token on stdin"
    exit 1
  fi
  if [[ ! "$new_token" =~ ^xox[pb]- ]]; then
    error "Token doesn't look like a Slack token (expected xoxp- or xoxb- prefix)"
    exit 1
  fi

  info "New token received (prefix=${new_token:0:5}, len=${#new_token})"
  info "Validating with Slack auth.test"
  local auth
  auth=$(slack_auth_test "$new_token")
  if [ "$(echo "$auth" | jq -r '.ok')" != "true" ]; then
    error "auth.test failed: $(echo "$auth" | jq -r '.error')"
    exit 3
  fi
  local team user user_id
  team=$(echo "$auth" | jq -r '.team')
  user=$(echo "$auth" | jq -r '.user')
  user_id=$(echo "$auth" | jq -r '.user_id')
  info "Auth ok: team=$team user=$user user_id=$user_id"

  local scopes
  scopes=$(slack_get_scopes "$new_token")
  note "x-oauth-scopes: $scopes"
  validate_scopes "$scopes"
  if [ -n "$MISSING_SCOPES" ]; then
    error "Token is missing required scopes:"
    printf "%s" "$MISSING_SCOPES" >&2
    error "Refusing to rotate. Add scopes at api.slack.com/apps, reinstall, try again."
    exit 4
  fi
  info "All ${#REQUIRED_SCOPES[@]} required scopes present"

  # Dry-run confirmation — show which vars will change, but not the token.
  note "About to update Windmill variables:"
  for v in "${VARS[@]}"; do
    note "  • $v"
  done

  for v in "${VARS[@]}"; do
    info "Updating $v"
    update_var_value "$v" "$new_token"
  done

  # Verify round-trip
  for v in "${VARS[@]}"; do
    local readback
    readback=$(get_var_value "$v")
    if [ "$readback" = "$new_token" ]; then
      info "Verified $v (length=${#readback})"
    else
      error "Verification failed for $v"
      exit 5
    fi
  done

  info "Rotation complete. ${#VARS[@]} variables updated."
}

main() {
  require_cmd curl
  require_cmd jq

  local sub="${1:-}"
  case "$sub" in
    check)  cmd_check ;;
    rotate) cmd_rotate ;;
    *)      usage ;;
  esac
}

main "$@"
