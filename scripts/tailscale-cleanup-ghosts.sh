#!/usr/bin/env bash
# =============================================================================
# tailscale-cleanup-ghosts.sh — Delete stale tailnet devices before re-enroll
# =============================================================================
# Decision: Prevent the "imladris → imladris-2 → imladris-3 → imladris-4"
# suffix bump that happens on every rebuild. When an EC2 instance is destroyed,
# the Tailscale control plane retains the device entry (default). If the name
# `imladris` is still held by a ghost, the next `tailscale up --hostname imladris`
# gets auto-renamed to `imladris-N` to avoid collision. Scripts and ~/.ssh
# aliases that target the canonical name then break.
#
# This helper deletes any tailnet device whose name matches the canonical
# hostname (or its -N suffixed variants) before re-enrollment, so the new
# node can claim the canonical name cleanly.
#
# Prereqs:
#   - bws CLI + BWS_ACCESS_TOKEN
#   - BWS secret `tailscale-api-key` (scopes: devices:core:read, devices:delete)
#
# Usage:
#   ./tailscale-cleanup-ghosts.sh                 # delete ghosts named imladris[-N]
#   ./tailscale-cleanup-ghosts.sh --name=foo      # different canonical name
#   ./tailscale-cleanup-ghosts.sh --dry-run       # list, don't delete
#
# Exit codes:
#   0   success OR cleanup skipped gracefully (missing token, missing key).
#       Missing prereqs log a warning but do not block bootstrap.
#   2   API call failed unexpectedly (auth invalid, network, etc.)
# =============================================================================

set -euo pipefail

CANONICAL_NAME="imladris"
DRY_RUN=0
TAILNET="${TAILSCALE_TAILNET:--}"   # "-" = tailnet of the authenticated key

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --name=*) CANONICAL_NAME="${arg#--name=}" ;;
    -h|--help)
      sed -n 's/^# \{0,1\}//;1,/^set -euo pipefail/p' "$0" | head -35
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 64 ;;
  esac
done

log() { printf '[tailscale-cleanup-ghosts] %s\n' "$*"; }
warn() { printf '[tailscale-cleanup-ghosts] WARN: %s\n' "$*" >&2; }

# --- Fail-open on missing prereqs: never block bootstrap. ---
if [ -z "${BWS_ACCESS_TOKEN:-}" ]; then
  warn "BWS_ACCESS_TOKEN not set — skipping ghost cleanup."
  warn "If the enrollment picks up an -N suffix, delete ghosts manually at"
  warn "  https://login.tailscale.com/admin/machines"
  exit 0
fi

if ! command -v bws >/dev/null 2>&1; then
  warn "bws CLI not found — skipping ghost cleanup."
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  warn "jq not found — skipping ghost cleanup."
  exit 0
fi

API_KEY="$(bws secret list -o json 2>/dev/null | jq -r '.[] | select(.key=="tailscale-api-key").value' || true)"
if [ -z "$API_KEY" ] || [ "$API_KEY" = "null" ]; then
  warn "BWS secret 'tailscale-api-key' not found — skipping ghost cleanup."
  warn "Create one at https://login.tailscale.com/admin/settings/keys (API keys)"
  warn "with scopes devices:core:read + devices:delete, then store as:"
  warn "  bws secret create tailscale-api-key <value> <project-id>"
  exit 0
fi

API_BASE="https://api.tailscale.com/api/v2"
tmpdir="$(mktemp -d)"; trap 'rm -rf "$tmpdir"' EXIT
devices_json="$tmpdir/devices.json"
http_code="$(curl -sS -o "$devices_json" -w '%{http_code}' \
  -H "Authorization: Bearer $API_KEY" \
  "$API_BASE/tailnet/$TAILNET/devices" || echo "000")"

if [ "$http_code" = "401" ]; then
  warn "Tailscale API returned 401 — 'tailscale-api-key' in BWS is invalid/expired."
  warn "Regenerate at https://login.tailscale.com/admin/settings/keys and update BWS."
  exit 0
fi
if [ "$http_code" != "200" ]; then
  warn "Tailscale API call failed (HTTP $http_code). Skipping cleanup."
  exit 2
fi

# Match device "name" field, which Tailscale sets to the MagicDNS-style full
# name like "imladris.dzo-musical.ts.net" or "imladris-4.dzo-musical.ts.net".
# We match the short prefix: ^<canonical>$ OR ^<canonical>-[0-9]+$
# e.g. "imladris", "imladris-2", ... "imladris-99"
match_regex="^${CANONICAL_NAME}(-[0-9]+)?\\."

ghost_rows="$(jq -r --arg re "$match_regex" \
  '.devices[] | select(.name|test($re)) | [.id, .name, .lastSeen] | @tsv' \
  "$devices_json")"

if [ -z "$ghost_rows" ]; then
  log "No devices match '${CANONICAL_NAME}' — nothing to clean up."
  exit 0
fi

# Identify the LIVE node (most recently seen). Keep it; delete the rest.
live_id="$(printf '%s\n' "$ghost_rows" | sort -k3 -r | awk -F'\t' 'NR==1{print $1}')"

count_total=0; count_deleted=0; count_kept=0
while IFS=$'\t' read -r dev_id dev_name last_seen; do
  count_total=$((count_total + 1))
  if [ "$dev_id" = "$live_id" ]; then
    log "KEEP   $dev_name  (id=$dev_id, last_seen=$last_seen)  ← most recent, assumed live"
    count_kept=$((count_kept + 1))
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "WOULD  $dev_name  (id=$dev_id, last_seen=$last_seen)  ← would delete"
    continue
  fi
  del_code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
    -H "Authorization: Bearer $API_KEY" \
    "$API_BASE/device/$dev_id" || echo "000")"
  if [ "$del_code" = "200" ] || [ "$del_code" = "204" ]; then
    log "DELETE $dev_name  (id=$dev_id)  OK"
    count_deleted=$((count_deleted + 1))
  else
    warn "DELETE $dev_name  (id=$dev_id)  FAILED (HTTP $del_code)"
  fi
done <<< "$ghost_rows"

log "Done. matched=$count_total kept=$count_kept deleted=$count_deleted dry_run=$DRY_RUN"
