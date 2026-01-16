#!/usr/bin/env bash
# cloud-assume - Unified cloud access control
# Source this file: source ~/bin/cloud-assume
#
# Works WITH auth-keeper (authentication) to provide authorization control.
# auth-keeper keeps you logged in; cloud-assume controls access level.
#
# Usage:
#   cloud-assume aws <env>           # readonly access
#   cloud-assume aws <env> --admin   # admin access (logged)
#   cloud-assume azure <sub>         # readonly subscription
#   cloud-assume azure <sub> --admin # admin subscription
#   cloud-assume gcp <project>       # readonly project
#   cloud-assume clear               # revoke all cloud access
#   cloud-assume status              # show current access

set -uo pipefail

# =============================================================================
# Configuration
# =============================================================================

# AWS account mapping: env -> account_id
# Loaded from BWS (Bitwarden Secrets Manager) to avoid hardcoding
declare -A CLOUD_AWS_ACCOUNTS

_cloud_load_aws_accounts() {
    # Only load once
    [[ ${#CLOUD_AWS_ACCOUNTS[@]} -gt 0 ]] && return 0

    # Check if bws_get is available
    if ! type bws_get &>/dev/null; then
        echo "[cloud-assume] Warning: bws_get not available, AWS accounts not loaded" >&2
        return 1
    fi

    # Load account IDs from BWS
    local qat dev prod buxtonorgacct
    qat=$(bws_get aws-account-qat 2>/dev/null) || true
    dev=$(bws_get aws-account-dev 2>/dev/null) || true
    prod=$(bws_get aws-account-prod 2>/dev/null) || true
    buxtonorgacct=$(bws_get aws-account-buxtonorgacct 2>/dev/null) || true

    [[ -n "$qat" ]] && CLOUD_AWS_ACCOUNTS[qat]="$qat"
    [[ -n "$dev" ]] && CLOUD_AWS_ACCOUNTS[dev]="$dev"
    [[ -n "$prod" ]] && CLOUD_AWS_ACCOUNTS[prod]="$prod"
    [[ -n "$buxtonorgacct" ]] && CLOUD_AWS_ACCOUNTS[buxtonorgacct]="$buxtonorgacct"

    return 0
}

# AWS role names
CLOUD_AWS_READONLY_ROLE="ImladrisReadOnly"
CLOUD_AWS_ADMIN_ROLE="ImladrisAdmin"

# Azure subscription mapping: env -> subscription_id (configure as needed)
declare -A CLOUD_AZURE_SUBS=(
    # [dev]="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    # [prod]="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
)

# GCP project mapping: env -> project_id (configure as needed)
declare -A CLOUD_GCP_PROJECTS=(
    # [dev]="my-dev-project"
    # [prod]="my-prod-project"
)

# Session duration (seconds)
CLOUD_AWS_SESSION_DURATION="${CLOUD_AWS_SESSION_DURATION:-3600}"
CLOUD_AWS_ADMIN_SESSION_DURATION="${CLOUD_AWS_ADMIN_SESSION_DURATION:-900}"  # 15 min for admin

# M365 scope definitions (requested at auth time, not app-level)
M365_SCOPES_PERSONAL="User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite Files.ReadWrite Tasks.ReadWrite Notes.ReadWrite Chat.ReadWrite Presence.Read"
M365_SCOPES_READONLY="User.Read User.Read.All Directory.Read.All AuditLog.Read.All Reports.Read.All Group.Read.All Sites.Read.All"
M365_SCOPES_ADMIN="User.Read User.ReadWrite.All Directory.ReadWrite.All Group.ReadWrite.All Sites.ReadWrite.All RoleManagement.ReadWrite.Directory Application.ReadWrite.All Mail.ReadWrite Mail.Send Calendars.ReadWrite"

# M365 Client ID (loaded from BWS)
M365_CLIENT_ID=""

_cloud_load_m365_config() {
    [[ -n "$M365_CLIENT_ID" ]] && return 0

    if ! type bws_get &>/dev/null; then
        echo "[cloud-assume] Warning: bws_get not available, M365 config not loaded" >&2
        return 1
    fi

    M365_CLIENT_ID=$(bws_get m365-client-id 2>/dev/null) || true
    [[ -z "$M365_CLIENT_ID" ]] && echo "[cloud-assume] Warning: m365-client-id not found in BWS" >&2
    return 0
}

# Log file for admin access
CLOUD_ACCESS_LOG="${CLOUD_ACCESS_LOG:-$HOME/.cache/cloud-assume/access.log}"

# Current access level tracking
CLOUD_CURRENT_PROVIDER=""
CLOUD_CURRENT_ENV=""
CLOUD_CURRENT_LEVEL=""

# =============================================================================
# Logging
# =============================================================================

_cloud_log() {
    local level="$1"
    shift
    local msg="$*"
    local timestamp
    timestamp=$(date -Iseconds)

    mkdir -p "$(dirname "$CLOUD_ACCESS_LOG")"
    echo "[$timestamp] [$level] $msg" >> "$CLOUD_ACCESS_LOG"

    if [[ "$level" == "ADMIN" ]]; then
        echo -e "\033[1;31m[cloud-assume] ADMIN ACCESS: $msg\033[0m" >&2
    else
        echo "[cloud-assume] $msg" >&2
    fi
}

# =============================================================================
# AWS
# =============================================================================

_cloud_aws_assume() {
    local env="$1"
    local admin="${2:-false}"

    # Load accounts from BWS if not already loaded
    _cloud_load_aws_accounts

    local account_id="${CLOUD_AWS_ACCOUNTS[$env]:-}"
    if [[ -z "$account_id" ]]; then
        echo "Unknown AWS environment: $env" >&2
        echo "Available: ${!CLOUD_AWS_ACCOUNTS[*]}" >&2
        return 1
    fi

    local role_name duration
    if [[ "$admin" == "true" ]]; then
        role_name="$CLOUD_AWS_ADMIN_ROLE"
        duration="$CLOUD_AWS_ADMIN_SESSION_DURATION"
        _cloud_log "ADMIN" "aws $env ($account_id) role=$role_name"
    else
        role_name="$CLOUD_AWS_READONLY_ROLE"
        duration="$CLOUD_AWS_SESSION_DURATION"
        _cloud_log "INFO" "aws $env ($account_id) role=$role_name"
    fi

    local role_arn="arn:aws:iam::${account_id}:role/${role_name}"
    local session_name="cloud-assume-$(date +%s)"

    # Use 'command aws' to bypass any wrapper functions
    local creds
    creds=$(command aws sts assume-role \
        --role-arn "$role_arn" \
        --role-session-name "$session_name" \
        --duration-seconds "$duration" \
        --output json 2>&1)

    if [[ $? -ne 0 ]]; then
        echo "Failed to assume role: $creds" >&2
        return 1
    fi

    # Export credentials
    export AWS_ACCESS_KEY_ID=$(echo "$creds" | jq -r '.Credentials.AccessKeyId')
    export AWS_SECRET_ACCESS_KEY=$(echo "$creds" | jq -r '.Credentials.SecretAccessKey')
    export AWS_SESSION_TOKEN=$(echo "$creds" | jq -r '.Credentials.SessionToken')
    export AWS_REGION="${AWS_REGION:-us-east-1}"

    # Clear any profile setting (we're using explicit creds now)
    unset AWS_PROFILE

    # Track current access
    CLOUD_CURRENT_PROVIDER="aws"
    CLOUD_CURRENT_ENV="$env"
    CLOUD_CURRENT_LEVEL="$([[ "$admin" == "true" ]] && echo "admin" || echo "readonly")"
    export CLOUD_CURRENT_PROVIDER CLOUD_CURRENT_ENV CLOUD_CURRENT_LEVEL

    local expiry
    expiry=$(echo "$creds" | jq -r '.Credentials.Expiration')
    echo "AWS $env ($CLOUD_CURRENT_LEVEL) - expires: $expiry"
}

_cloud_aws_clear() {
    unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
    _cloud_log "INFO" "aws credentials cleared"
}

# =============================================================================
# Azure
# =============================================================================

_cloud_azure_assume() {
    local env="$1"
    local admin="${2:-false}"

    local sub_id="${CLOUD_AZURE_SUBS[$env]:-}"
    if [[ -z "$sub_id" ]]; then
        # If no mapping, try using env as subscription name directly
        echo "No Azure subscription mapping for '$env', attempting to use as subscription name..." >&2
        if [[ "$admin" == "true" ]]; then
            _cloud_log "ADMIN" "azure $env (subscription name)"
        else
            _cloud_log "INFO" "azure $env (subscription name)"
        fi
        command az account set --subscription "$env"
    else
        if [[ "$admin" == "true" ]]; then
            _cloud_log "ADMIN" "azure $env ($sub_id)"
        else
            _cloud_log "INFO" "azure $env ($sub_id)"
        fi
        command az account set --subscription "$sub_id"
    fi

    if [[ $? -eq 0 ]]; then
        CLOUD_CURRENT_PROVIDER="azure"
        CLOUD_CURRENT_ENV="$env"
        CLOUD_CURRENT_LEVEL="$([[ "$admin" == "true" ]] && echo "admin" || echo "readonly")"
        export CLOUD_CURRENT_PROVIDER CLOUD_CURRENT_ENV CLOUD_CURRENT_LEVEL

        local current
        current=$(command az account show --query '{name:name, id:id}' -o tsv 2>/dev/null)
        echo "Azure: $current ($CLOUD_CURRENT_LEVEL)"
    fi
}

_cloud_azure_clear() {
    # Azure doesn't have a "clear" concept - you're always in some subscription
    # Best we can do is show warning
    echo "Azure: subscription context cannot be fully cleared" >&2
    echo "Consider: az logout (but this logs you out entirely)" >&2
}

# =============================================================================
# GCP
# =============================================================================

_cloud_gcp_assume() {
    local env="$1"
    local admin="${2:-false}"

    local project_id="${CLOUD_GCP_PROJECTS[$env]:-}"
    if [[ -z "$project_id" ]]; then
        # If no mapping, try using env as project directly
        echo "No GCP project mapping for '$env', attempting to use as project ID..." >&2
        project_id="$env"
    fi

    if [[ "$admin" == "true" ]]; then
        _cloud_log "ADMIN" "gcp $env ($project_id)"
    else
        _cloud_log "INFO" "gcp $env ($project_id)"
    fi

    command gcloud config set project "$project_id" 2>/dev/null

    if [[ $? -eq 0 ]]; then
        CLOUD_CURRENT_PROVIDER="gcp"
        CLOUD_CURRENT_ENV="$env"
        CLOUD_CURRENT_LEVEL="$([[ "$admin" == "true" ]] && echo "admin" || echo "readonly")"
        export CLOUD_CURRENT_PROVIDER CLOUD_CURRENT_ENV CLOUD_CURRENT_LEVEL

        echo "GCP: $project_id ($CLOUD_CURRENT_LEVEL)"
    fi
}

_cloud_gcp_clear() {
    command gcloud config unset project 2>/dev/null
    _cloud_log "INFO" "gcp project cleared"
}

# =============================================================================
# M365 (Microsoft Graph)
# =============================================================================

_cloud_m365_assume() {
    local level="${1:-personal}"

    _cloud_load_m365_config
    if [[ -z "$M365_CLIENT_ID" ]]; then
        echo "M365 Client ID not configured. Add m365-client-id to BWS." >&2
        return 1
    fi

    local scopes
    case "$level" in
        personal|p)
            scopes="$M365_SCOPES_PERSONAL"
            level="personal"
            _cloud_log "INFO" "m365 personal access"
            ;;
        readonly|ro|r)
            scopes="$M365_SCOPES_READONLY"
            level="readonly"
            _cloud_log "INFO" "m365 readonly access"
            ;;
        admin|a)
            scopes="$M365_SCOPES_ADMIN"
            level="admin"
            _cloud_log "ADMIN" "m365 admin access"
            ;;
        *)
            echo "Unknown M365 level: $level" >&2
            echo "Available: personal, readonly, admin" >&2
            return 1
            ;;
    esac

    # Convert space-separated scopes to comma-separated for PowerShell
    local scope_array
    scope_array=$(echo "$scopes" | tr ' ' ',')

    echo "Authenticating to Microsoft Graph ($level)..."
    echo "A browser window will open for sign-in."

    # Run PowerShell to connect - this will prompt for device code auth
    local result
    result=$(pwsh -Command "
        \$ErrorActionPreference = 'Stop'
        try {
            Connect-MgGraph -ClientId '$M365_CLIENT_ID' -Scopes '$scope_array' -NoWelcome
            \$ctx = Get-MgContext
            Write-Output \"SUCCESS|\$(\$ctx.Account)|\$(\$ctx.Scopes -join ',')|\"
        } catch {
            Write-Output \"ERROR|\$_\"
        }
    " 2>&1)

    if [[ "$result" == SUCCESS* ]]; then
        local account scopes_granted
        account=$(echo "$result" | cut -d'|' -f2)
        scopes_granted=$(echo "$result" | cut -d'|' -f3)

        CLOUD_CURRENT_PROVIDER="m365"
        CLOUD_CURRENT_ENV="$account"
        CLOUD_CURRENT_LEVEL="$level"
        export CLOUD_CURRENT_PROVIDER CLOUD_CURRENT_ENV CLOUD_CURRENT_LEVEL

        echo "M365 $level - account: $account"
    else
        echo "Failed to connect to Microsoft Graph:" >&2
        echo "$result" >&2
        return 1
    fi
}

_cloud_m365_clear() {
    pwsh -Command "Disconnect-MgGraph" 2>/dev/null || true
    _cloud_log "INFO" "m365 disconnected"
}

_cloud_m365_status() {
    local result
    result=$(pwsh -Command "
        try {
            \$ctx = Get-MgContext
            if (\$ctx) {
                Write-Output \"Connected: \$(\$ctx.Account) | Scopes: \$(\$ctx.Scopes.Count) granted\"
            } else {
                Write-Output 'Not connected'
            }
        } catch {
            Write-Output 'Not connected'
        }
    " 2>&1)
    echo "M365: $result"
}

# =============================================================================
# Main Interface
# =============================================================================

cloud-assume() {
    local provider="${1:-}"
    local env="${2:-}"
    local flag="${3:-}"
    local admin="false"

    # Handle --admin flag in any position
    if [[ "$env" == "--admin" ]]; then
        admin="true"
        env="$flag"
        flag=""
    elif [[ "$flag" == "--admin" ]]; then
        admin="true"
    fi

    case "$provider" in
        aws)
            [[ -z "$env" ]] && { echo "Usage: cloud-assume aws <env> [--admin]"; return 1; }
            _cloud_aws_assume "$env" "$admin"
            ;;
        azure|az)
            [[ -z "$env" ]] && { echo "Usage: cloud-assume azure <subscription> [--admin]"; return 1; }
            _cloud_azure_assume "$env" "$admin"
            ;;
        gcp|gcloud)
            [[ -z "$env" ]] && { echo "Usage: cloud-assume gcp <project> [--admin]"; return 1; }
            _cloud_gcp_assume "$env" "$admin"
            ;;
        m365|microsoft|ms)
            # M365 uses level instead of env: personal, readonly, admin
            local level="${env:-personal}"
            if [[ "$level" == "--admin" ]] || [[ "$admin" == "true" ]]; then
                level="admin"
            fi
            _cloud_m365_assume "$level"
            ;;
        clear|revoke)
            _cloud_aws_clear
            _cloud_azure_clear
            _cloud_gcp_clear
            _cloud_m365_clear
            unset CLOUD_CURRENT_PROVIDER CLOUD_CURRENT_ENV CLOUD_CURRENT_LEVEL
            echo "All cloud access cleared"
            ;;
        status|s)
            echo "=== cloud-assume status ==="
            if [[ -n "${CLOUD_CURRENT_PROVIDER:-}" ]]; then
                echo "Active: $CLOUD_CURRENT_PROVIDER / $CLOUD_CURRENT_ENV ($CLOUD_CURRENT_LEVEL)"
            else
                echo "Active: none"
            fi
            echo ""
            echo "AWS credentials:"
            if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
                command aws sts get-caller-identity 2>/dev/null || echo "  (invalid/expired)"
            else
                echo "  (not set)"
            fi
            echo ""
            echo "Azure subscription:"
            command az account show --query '{name:name, id:id}' -o tsv 2>/dev/null || echo "  (not logged in)"
            echo ""
            echo "GCP project:"
            command gcloud config get-value project 2>/dev/null || echo "  (not set)"
            echo ""
            _cloud_m365_status
            ;;
        help|--help|-h)
            cat <<'EOF'
cloud-assume - Unified cloud access control

Usage:
  cloud-assume <provider> <environment> [--admin]
  cloud-assume clear
  cloud-assume status

Providers:
  aws <env>      Assume AWS role (qat, dev, prod, buxtonorgacct)
  azure <sub>    Set Azure subscription
  gcp <project>  Set GCP project
  m365 [level]   Microsoft Graph (personal, readonly, admin)

Flags:
  --admin        Request admin/elevated access (logged, shorter session)

M365 Levels:
  personal       Your mail, calendar, files (default)
  readonly       Tenant-wide read access
  admin          Full admin access (logged!)

Examples:
  cloud-assume aws qat           # readonly access to QAT
  cloud-assume aws prod --admin  # admin access to prod (logged!)
  cloud-assume azure dev         # switch to dev subscription
  cloud-assume m365              # personal M365 access (mail, calendar)
  cloud-assume m365 readonly     # tenant-wide read access
  cloud-assume m365 admin        # full admin access (logged!)
  cloud-assume clear             # revoke all access

Environment:
  CLOUD_AWS_SESSION_DURATION         Readonly session (default: 3600)
  CLOUD_AWS_ADMIN_SESSION_DURATION   Admin session (default: 900)
  CLOUD_ACCESS_LOG                   Log file path
EOF
            ;;
        "")
            echo "Usage: cloud-assume <provider> <env> [--admin]"
            echo "       cloud-assume status"
            echo "       cloud-assume help"
            ;;
        *)
            echo "Unknown provider: $provider"
            echo "Supported: aws, azure, gcp"
            return 1
            ;;
    esac
}

# Completion
if [[ -n "${ZSH_VERSION:-}" ]]; then
    _cloud_assume_complete() {
        local -a providers envs flags
        providers=(aws azure gcp clear status help)
        flags=(--admin)

        case "${words[2]:-}" in
            aws)
                envs=(${(k)CLOUD_AWS_ACCOUNTS})
                _describe 'environment' envs
                _describe 'flags' flags
                ;;
            azure)
                envs=(${(k)CLOUD_AZURE_SUBS})
                _describe 'subscription' envs
                _describe 'flags' flags
                ;;
            gcp)
                envs=(${(k)CLOUD_GCP_PROJECTS})
                _describe 'project' envs
                _describe 'flags' flags
                ;;
            *)
                _describe 'provider' providers
                ;;
        esac
    }
    compdef _cloud_assume_complete cloud-assume
fi

# Aliases for convenience
alias ca='cloud-assume'
alias caa='cloud-assume aws'
alias caz='cloud-assume azure'
alias cag='cloud-assume gcp'
alias cam='cloud-assume m365'
