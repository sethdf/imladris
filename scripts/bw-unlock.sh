#!/usr/bin/env bash
# bw-unlock - Unlock Bitwarden and cache session
set -uo pipefail
BW_SESSION_FILE="$HOME/.config/bitwarden/session"
_status() { bw status 2>/dev/null | jq -r '.status' 2>/dev/null || echo "unknown"; }
_save() { mkdir -p "$(dirname "$BW_SESSION_FILE")" && echo "$BW_SESSION" > "$BW_SESSION_FILE" && chmod 600 "$BW_SESSION_FILE"; }
_load() {
    [[ -f "$BW_SESSION_FILE" ]] || return 1
    BW_SESSION=$(cat "$BW_SESSION_FILE")
    export BW_SESSION
    [[ "$(_status)" == "unlocked" ]]
}
_unlock() {
    command -v bw &>/dev/null || { echo "Error: bw not installed"; return 1; }
    _load && { echo "Session restored"; return 0; }
    case "$(_status)" in
        unlocked) echo "Already unlocked" ;;
        locked) BW_SESSION=$(bw unlock --raw) && export BW_SESSION && _save && echo "Unlocked" ;;
        unauthenticated) bw login && BW_SESSION=$(bw unlock --raw) && export BW_SESSION && _save && echo "Logged in" ;;
        *) echo "Unknown status"; return 1 ;;
    esac
}
_unlock
