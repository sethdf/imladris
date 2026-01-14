#!/usr/bin/env bash
# claude-backend - Switch between Claude Code payment/quota backends
# Source this file: source ~/bin/claude-backend
#
# Manages three backends:
#   1. AWS Bedrock (instance role, AWS billing)
#   2. Team Premium (OAuth, team quota)
#   3. Personal Max (OAuth, personal quota)
#
# Usage:
#   claude-backend bedrock           # Use Bedrock (current account)
#   claude-backend bedrock --account <env>  # Use Bedrock via assumed role
#   claude-backend team              # Use Team Premium plan
#   claude-backend personal          # Use Personal Max plan
#   claude-backend status            # Show current backend
#   claude-backend backup            # Backup OAuth credentials to BWS

set -uo pipefail

# =============================================================================
# Configuration
# =============================================================================

CLAUDE_CONFIG_DIR="${HOME}/.config/claude"
CLAUDE_AUTH_FILE="${CLAUDE_CONFIG_DIR}/auth.json"
CLAUDE_BACKUP_DIR="${CLAUDE_CONFIG_DIR}/backups"
CLAUDE_BACKEND_FILE="${CLAUDE_CONFIG_DIR}/current-backend"

# BWS secret names for OAuth tokens
BWS_TEAM_TOKEN="claude-code-team-oauth"
BWS_PERSONAL_TOKEN="claude-code-personal-oauth"

# Current backend tracking
CLAUDE_CURRENT_BACKEND="${CLAUDE_CURRENT_BACKEND:-}"

# Default backend (personal > team > bedrock)
CLAUDE_DEFAULT_BACKEND="${CLAUDE_DEFAULT_BACKEND:-personal}"

# =============================================================================
# Helpers
# =============================================================================

_cb_log() {
    local level="$1"
    shift
    echo "[claude-backend] $*" >&2
}

_cb_ensure_config_dir() {
    mkdir -p "$CLAUDE_CONFIG_DIR"
    mkdir -p "$CLAUDE_BACKUP_DIR"
}

_cb_claude_running() {
    pgrep -u "$USER" -x "claude" >/dev/null 2>&1
}

_cb_warn_restart() {
    if _cb_claude_running; then
        echo "" >&2
        _cb_log "WARNING: Claude Code is currently running"
        _cb_log "Backend changes require restarting Claude Code"
        _cb_log "Your conversation history is saved locally and will be available after restart"
        echo "" >&2
        return 0
    fi
    return 1
}

_cb_save_backend() {
    local backend="$1"
    local account="${2:-}"

    _cb_ensure_config_dir

    if [[ -n "$account" ]]; then
        echo "${backend}:${account}" > "$CLAUDE_BACKEND_FILE"
    else
        echo "$backend" > "$CLAUDE_BACKEND_FILE"
    fi

    chmod 600 "$CLAUDE_BACKEND_FILE"
}

_cb_load_backend() {
    if [[ ! -f "$CLAUDE_BACKEND_FILE" ]]; then
        # No saved backend, use default
        _cb_log "No saved backend, initializing to: $CLAUDE_DEFAULT_BACKEND"
        _cb_save_backend "$CLAUDE_DEFAULT_BACKEND"
        echo "$CLAUDE_DEFAULT_BACKEND"
        return
    fi

    cat "$CLAUDE_BACKEND_FILE"
}

_cb_apply_backend() {
    local backend_spec
    backend_spec=$(_cb_load_backend)

    local backend account
    if [[ "$backend_spec" == *:* ]]; then
        backend="${backend_spec%%:*}"
        account="${backend_spec#*:}"
    else
        backend="$backend_spec"
        account=""
    fi

    case "$backend" in
        bedrock)
            _cb_bedrock_apply "$account"
            ;;
        team)
            _cb_oauth_apply "team"
            ;;
        personal)
            _cb_oauth_apply "personal"
            ;;
        *)
            _cb_log "Warning: Unknown backend '$backend', defaulting to $CLAUDE_DEFAULT_BACKEND"
            _cb_save_backend "$CLAUDE_DEFAULT_BACKEND"
            _cb_apply_backend
            ;;
    esac
}

# =============================================================================
# Bedrock
# =============================================================================

_cb_bedrock_apply() {
    local account="${1:-}"

    # If account specified, use cloud-assume to get credentials
    if [[ -n "$account" ]]; then
        if type cloud-assume &>/dev/null; then
            cloud-assume aws "$account" >/dev/null 2>&1 || true
        fi
    fi

    # Set Bedrock environment variables
    export CLAUDE_CODE_USE_BEDROCK=1
    export AWS_REGION="${AWS_REGION:-us-east-1}"

    # Track backend
    export CLAUDE_CURRENT_BACKEND="bedrock${account:+:$account}"
}

_cb_bedrock_switch() {
    local account="${1:-}"

    _cb_log "Switching to Bedrock backend"

    # If account specified, use cloud-assume to get credentials
    if [[ -n "$account" ]]; then
        if ! type cloud-assume &>/dev/null; then
            _cb_log "Error: cloud-assume not available"
            return 1
        fi

        _cb_log "Assuming role in account: $account"
        cloud-assume aws "$account" || return 1
    fi

    # Apply Bedrock settings
    _cb_bedrock_apply "$account"

    # Clear OAuth config (if exists)
    _cb_ensure_config_dir
    if [[ -f "$CLAUDE_AUTH_FILE" ]]; then
        local backup_name="auth-$(date +%Y%m%d-%H%M%S).json"
        mv "$CLAUDE_AUTH_FILE" "${CLAUDE_BACKUP_DIR}/${backup_name}"
        _cb_log "Backed up OAuth config to: ${backup_name}"
    fi

    # Save backend choice
    _cb_save_backend "bedrock" "$account"

    _cb_log "Bedrock backend active"
    if [[ -n "$account" ]]; then
        _cb_log "Using assumed role in account: $account"
    else
        _cb_log "Using instance role"
    fi

    # Warn if Claude is running
    _cb_warn_restart
}

# =============================================================================
# OAuth (Team / Personal)
# =============================================================================

_cb_oauth_apply() {
    local plan="$1"  # "team" or "personal"

    # Unset Bedrock environment
    unset CLAUDE_CODE_USE_BEDROCK

    # Ensure auth file exists or will be loaded
    _cb_ensure_config_dir

    # Determine which BWS secret to use
    local bws_secret
    case "$plan" in
        team)
            bws_secret="$BWS_TEAM_TOKEN"
            ;;
        personal)
            bws_secret="$BWS_PERSONAL_TOKEN"
            ;;
    esac

    # Try to restore credentials from BWS if auth file doesn't exist
    if [[ ! -f "$CLAUDE_AUTH_FILE" ]] && type bws_get &>/dev/null; then
        local oauth_data
        if oauth_data=$(bws_get "$bws_secret" 2>/dev/null); then
            echo "$oauth_data" > "$CLAUDE_AUTH_FILE"
            chmod 600 "$CLAUDE_AUTH_FILE"
        fi
    fi

    # Track backend
    export CLAUDE_CURRENT_BACKEND="oauth:$plan"
}

_cb_oauth_switch() {
    local plan="$1"  # "team" or "personal"

    _cb_log "Switching to $plan plan"

    # Determine which BWS secret to use
    local bws_secret
    case "$plan" in
        team)
            bws_secret="$BWS_TEAM_TOKEN"
            ;;
        personal)
            bws_secret="$BWS_PERSONAL_TOKEN"
            ;;
        *)
            _cb_log "Error: Unknown plan: $plan"
            return 1
            ;;
    esac

    # Check if bws_get is available
    if ! type bws_get &>/dev/null; then
        _cb_log "Error: bws_get not available (source bws-init.sh first)"
        return 1
    fi

    # Ensure config directory exists
    _cb_ensure_config_dir

    # Backup current auth file if it exists
    if [[ -f "$CLAUDE_AUTH_FILE" ]]; then
        local backup_name="auth-$(date +%Y%m%d-%H%M%S).json"
        mv "$CLAUDE_AUTH_FILE" "${CLAUDE_BACKUP_DIR}/${backup_name}"
        _cb_log "Backed up previous config to: ${backup_name}"
    fi

    # Try to fetch credentials from BWS
    local oauth_data
    if oauth_data=$(bws_get "$bws_secret" 2>/dev/null); then
        _cb_log "Loaded OAuth credentials from BWS"
        echo "$oauth_data" > "$CLAUDE_AUTH_FILE"
        chmod 600 "$CLAUDE_AUTH_FILE"

        # Check token validity using auth-keeper (if available)
        if type _ak_claude_token_valid &>/dev/null; then
            if _ak_claude_token_valid; then
                _cb_log "OAuth tokens are valid"
            elif type _ak_claude_has_refresh &>/dev/null && _ak_claude_has_refresh; then
                _cb_log "Access token expired, but refresh token present"
                _cb_log "Claude Code will auto-refresh on startup"
            else
                _cb_log "Warning: Tokens may be expired and no refresh token found"
                _cb_log "You may need to re-authenticate"
            fi
        fi
    else
        _cb_log "Warning: No OAuth credentials in BWS for $plan"
        _cb_log "You'll need to authenticate when you start Claude Code"
        _cb_log "After authenticating, run: claude-backend backup"
    fi

    # Apply OAuth settings
    _cb_oauth_apply "$plan"

    # Save backend choice
    _cb_save_backend "$plan"

    _cb_log "$plan plan active"

    # Warn if Claude is running
    _cb_warn_restart
}

# =============================================================================
# Backup
# =============================================================================

_cb_backup() {
    if [[ ! -f "$CLAUDE_AUTH_FILE" ]]; then
        _cb_log "Error: No auth file to backup"
        return 1
    fi

    if ! type bws &>/dev/null; then
        _cb_log "Error: bws CLI not available"
        return 1
    fi

    _cb_log "Backing up OAuth credentials to BWS"

    # Detect which plan this is (would need heuristic or ask user)
    # For now, ask interactively
    echo "Which plan is this? (team/personal): " >&2
    read -r plan

    local bws_secret
    case "$plan" in
        team)
            bws_secret="$BWS_TEAM_TOKEN"
            ;;
        personal)
            bws_secret="$BWS_PERSONAL_TOKEN"
            ;;
        *)
            _cb_log "Error: Invalid plan. Use 'team' or 'personal'"
            return 1
            ;;
    esac

    # Read current auth file
    local auth_content
    auth_content=$(cat "$CLAUDE_AUTH_FILE")

    # Check if secret exists, update or create
    if bws_exists "$bws_secret" 2>/dev/null; then
        _cb_log "Updating existing secret: $bws_secret"
        # Note: BWS doesn't have a simple "update" command, you'd need to use the API
        _cb_log "Manual update required - use BWS web interface or API"
        _cb_log "Secret name: $bws_secret"
        echo "$auth_content"
    else
        _cb_log "Creating new secret: $bws_secret"
        _cb_log "Use BWS CLI or web interface to create:"
        _cb_log "  Key: $bws_secret"
        _cb_log "  Value: (paste the content below)"
        echo "$auth_content"
    fi
}

# =============================================================================
# Status
# =============================================================================

_cb_status() {
    echo "=== claude-backend status ==="

    if [[ -n "${CLAUDE_CURRENT_BACKEND:-}" ]]; then
        echo "Current: $CLAUDE_CURRENT_BACKEND"
    else
        echo "Current: unknown (check environment)"
    fi

    echo ""
    echo "Bedrock:"
    if [[ "${CLAUDE_CODE_USE_BEDROCK:-}" == "1" ]]; then
        echo "  ✓ Enabled (CLAUDE_CODE_USE_BEDROCK=1)"
        echo "  AWS Identity:"
        command aws sts get-caller-identity 2>/dev/null || echo "    (error getting identity)"
    else
        echo "  - Not enabled"
    fi

    echo ""
    echo "OAuth:"
    if [[ -f "$CLAUDE_AUTH_FILE" ]]; then
        echo "  ✓ Auth file exists: $CLAUDE_AUTH_FILE"
        echo "  Modified: $(stat -c %y "$CLAUDE_AUTH_FILE" 2>/dev/null || stat -f %Sm "$CLAUDE_AUTH_FILE" 2>/dev/null)"
    else
        echo "  - No auth file"
    fi

    echo ""
    echo "BWS Secrets:"
    if type bws_exists &>/dev/null; then
        if bws_exists "$BWS_TEAM_TOKEN" 2>/dev/null; then
            echo "  ✓ Team credentials stored"
        else
            echo "  - Team credentials not found"
        fi

        if bws_exists "$BWS_PERSONAL_TOKEN" 2>/dev/null; then
            echo "  ✓ Personal credentials stored"
        else
            echo "  - Personal credentials not found"
        fi
    else
        echo "  - BWS not available"
    fi

    echo ""
    echo "Backups:"
    if [[ -d "$CLAUDE_BACKUP_DIR" ]]; then
        local backup_count
        backup_count=$(find "$CLAUDE_BACKUP_DIR" -name "auth-*.json" 2>/dev/null | wc -l)
        echo "  $backup_count backup(s) in $CLAUDE_BACKUP_DIR"
    else
        echo "  - No backup directory"
    fi
}

# =============================================================================
# Main Interface
# =============================================================================

claude-backend() {
    local cmd="${1:-}"
    shift || true

    case "$cmd" in
        bedrock|aws)
            local account=""
            if [[ "${1:-}" == "--account" ]]; then
                account="${2:-}"
                if [[ -z "$account" ]]; then
                    echo "Error: --account requires an environment name" >&2
                    return 1
                fi
            fi
            _cb_bedrock_switch "$account"
            ;;

        team)
            _cb_oauth_switch "team"
            ;;

        personal|max)
            _cb_oauth_switch "personal"
            ;;

        backup)
            _cb_backup
            ;;

        status|s)
            _cb_status
            ;;

        help|--help|-h)
            cat <<'EOF'
claude-backend - Switch between Claude Code payment/quota backends

Usage:
  claude-backend <backend>
  claude-backend bedrock [--account <env>]
  claude-backend status
  claude-backend backup

Backends:
  bedrock              Use AWS Bedrock (instance role, AWS billing)
  bedrock --account    Use Bedrock via assumed role in other account
  team                 Use Claude Team Premium (OAuth, team quota)
  personal             Use Claude Personal Max (OAuth, personal quota)

Commands:
  status               Show current backend and configuration
  backup               Backup current OAuth credentials to BWS

Examples:
  claude-backend bedrock              # Use Bedrock with instance role
  claude-backend bedrock --account prod  # Use Bedrock in prod account
  claude-backend team                 # Switch to Team Premium
  claude-backend personal             # Switch to Personal Max
  claude-backend status               # Check current backend

OAuth credentials are:
  - Stored in ~/.config/claude/auth.json
  - Backed up automatically when switching
  - Can be restored from BWS (claude-code-team-oauth, claude-code-personal-oauth)

Mid-conversation switching:
  - Backend changes require restarting Claude Code
  - Conversation history is saved locally (~/.claude/history.jsonl)
  - Simply restart Claude after switching to continue your work
  - You'll be warned if Claude is currently running
EOF
            ;;

        "")
            echo "Usage: claude-backend <backend>"
            echo "       claude-backend status"
            echo "       claude-backend help"
            echo ""
            echo "Backends: bedrock, team, personal"
            ;;

        *)
            echo "Unknown backend: $cmd"
            echo "Use: bedrock, team, personal"
            return 1
            ;;
    esac
}

# =============================================================================
# Claude Command Wrapper (with token refresh check)
# =============================================================================

claude() {
    # Check if using OAuth (auth file exists)
    if [[ -f "$CLAUDE_AUTH_FILE" ]]; then
        # Check token validity using auth-keeper (if available)
        if type _ak_claude_token_valid &>/dev/null; then
            if ! _ak_claude_token_valid; then
                if type _ak_claude_has_refresh &>/dev/null && _ak_claude_has_refresh; then
                    echo "[claude-backend] Access token expired, refresh token present" >&2
                    echo "[claude-backend] Claude Code will auto-refresh on startup" >&2
                else
                    echo "[claude-backend] Warning: Tokens may be expired" >&2
                    echo "[claude-backend] You may need to re-authenticate" >&2
                fi
            fi
        fi
    fi

    # Launch Claude Code
    command claude "$@"
}

# Aliases
alias cb='claude-backend'
alias cbs='claude-backend status'

# Completion for zsh
if [[ -n "${ZSH_VERSION:-}" ]]; then
    _claude_backend_complete() {
        local -a commands
        commands=(bedrock team personal backup status help)
        _describe 'command' commands
    }
    compdef _claude_backend_complete claude-backend
fi
