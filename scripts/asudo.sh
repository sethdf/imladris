#!/usr/bin/env bash
# asudo - Unified service access control (like sudo for services)
# Source this file: source ~/bin/asudo
#
# Works WITH auth-keeper (authentication) to provide authorization control.
# auth-keeper keeps you logged in; asudo controls access level.
#
# Usage:
#   asudo aws <env>           # readonly access
#   asudo aws <env> --admin   # admin access (logged)
#   asudo azure <sub>         # readonly subscription
#   asudo azure <sub> --admin # admin subscription
#   asudo gcp <project>       # readonly project
#   asudo m365 [level]        # M365 access (personal, readonly, admin)
#   asudo clear               # revoke all access
#   asudo status              # show current access

set -uo pipefail

# =============================================================================
# Configuration
# =============================================================================

# AWS account mapping: env -> account_id
# Loaded from BWS (Bitwarden Secrets Manager) to avoid hardcoding
declare -A ASUDO_AWS_ACCOUNTS

_asudo_load_aws_accounts() {
    # Only load once
    [[ ${#ASUDO_AWS_ACCOUNTS[@]} -gt 0 ]] && return 0

    # Check if bws_get is available
    if ! type bws_get &>/dev/null; then
        echo "[asudo] Warning: bws_get not available, AWS accounts not loaded" >&2
        return 1
    fi

    # Load account IDs from BWS
    local qat dev prod buxtonorgacct
    qat=$(bws_get aws-account-qat 2>/dev/null) || true
    dev=$(bws_get aws-account-dev 2>/dev/null) || true
    prod=$(bws_get aws-account-prod 2>/dev/null) || true
    buxtonorgacct=$(bws_get aws-account-buxtonorgacct 2>/dev/null) || true

    [[ -n "$qat" ]] && ASUDO_AWS_ACCOUNTS[qat]="$qat"
    [[ -n "$dev" ]] && ASUDO_AWS_ACCOUNTS[dev]="$dev"
    [[ -n "$prod" ]] && ASUDO_AWS_ACCOUNTS[prod]="$prod"
    [[ -n "$buxtonorgacct" ]] && ASUDO_AWS_ACCOUNTS[buxtonorgacct]="$buxtonorgacct"

    return 0
}

# AWS role names
ASUDO_AWS_READONLY_ROLE="ImladrisReadOnly"
ASUDO_AWS_ADMIN_ROLE="ImladrisAdmin"

# Azure subscription mapping: env -> subscription_id (configure as needed)
declare -A ASUDO_AZURE_SUBS=(
    # [dev]="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    # [prod]="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
)

# GCP project mapping: env -> project_id (configure as needed)
declare -A ASUDO_GCP_PROJECTS=(
    # [dev]="my-dev-project"
    # [prod]="my-prod-project"
)

# Session duration (seconds)
ASUDO_AWS_SESSION_DURATION="${ASUDO_AWS_SESSION_DURATION:-3600}"
ASUDO_AWS_ADMIN_SESSION_DURATION="${ASUDO_AWS_ADMIN_SESSION_DURATION:-900}"  # 15 min for admin

# M365 scope definitions (requested at auth time, not app-level)
M365_SCOPES_PERSONAL="User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite Files.ReadWrite Tasks.ReadWrite Notes.ReadWrite Chat.ReadWrite Presence.Read"
M365_SCOPES_READONLY="User.Read User.Read.All Directory.Read.All AuditLog.Read.All Reports.Read.All Group.Read.All Sites.Read.All"
M365_SCOPES_ADMIN="User.Read User.ReadWrite.All Directory.ReadWrite.All Group.ReadWrite.All Sites.ReadWrite.All RoleManagement.ReadWrite.Directory Application.ReadWrite.All Mail.ReadWrite Mail.Send Calendars.ReadWrite"

# M365 config (loaded from BWS - never echo these values)
M365_CLIENT_ID=""
M365_TENANT_ID=""
M365_CLIENT_SECRET=""

_asudo_load_m365_config() {
    [[ -n "$M365_CLIENT_ID" && -n "$M365_TENANT_ID" ]] && return 0

    if ! type bws_get &>/dev/null; then
        echo "[asudo] Warning: bws_get not available, M365 config not loaded" >&2
        return 1
    fi

    M365_CLIENT_ID=$(bws_get m365-client-id 2>/dev/null) || true
    M365_TENANT_ID=$(bws_get m365-tenant-id 2>/dev/null) || true
    M365_CLIENT_SECRET=$(bws_get m365-client-secret 2>/dev/null) || true

    [[ -z "$M365_CLIENT_ID" ]] && echo "[asudo] Warning: m365-client-id not found in BWS" >&2
    [[ -z "$M365_TENANT_ID" ]] && echo "[asudo] Warning: m365-tenant-id not found in BWS" >&2
    # Client secret is optional - only needed for app-only auth
    return 0
}

# Log file for admin access
ASUDO_ACCESS_LOG="${ASUDO_ACCESS_LOG:-$HOME/.cache/asudo/access.log}"

# Current access level tracking
ASUDO_CURRENT_PROVIDER=""
ASUDO_CURRENT_ENV=""
ASUDO_CURRENT_LEVEL=""

# =============================================================================
# Logging
# =============================================================================

_asudo_log() {
    local level="$1"
    shift
    local msg="$*"
    local timestamp
    timestamp=$(date -Iseconds)

    mkdir -p "$(dirname "$ASUDO_ACCESS_LOG")"
    echo "[$timestamp] [$level] $msg" >> "$ASUDO_ACCESS_LOG"

    if [[ "$level" == "ADMIN" ]]; then
        echo -e "\033[1;31m[asudo] ADMIN ACCESS: $msg\033[0m" >&2
    else
        echo "[asudo] $msg" >&2
    fi
}

# =============================================================================
# AWS
# =============================================================================

_asudo_aws_assume() {
    local env="$1"
    local admin="${2:-false}"

    # Load accounts from BWS if not already loaded
    _asudo_load_aws_accounts

    local account_id="${ASUDO_AWS_ACCOUNTS[$env]:-}"
    if [[ -z "$account_id" ]]; then
        echo "Unknown AWS environment: $env" >&2
        echo "Available: ${!ASUDO_AWS_ACCOUNTS[*]}" >&2
        return 1
    fi

    local role_name duration
    if [[ "$admin" == "true" ]]; then
        role_name="$ASUDO_AWS_ADMIN_ROLE"
        duration="$ASUDO_AWS_ADMIN_SESSION_DURATION"
        _asudo_log "ADMIN" "aws $env ($account_id) role=$role_name"
    else
        role_name="$ASUDO_AWS_READONLY_ROLE"
        duration="$ASUDO_AWS_SESSION_DURATION"
        _asudo_log "INFO" "aws $env ($account_id) role=$role_name"
    fi

    local role_arn="arn:aws:iam::${account_id}:role/${role_name}"
    local session_name="asudo-$(date +%s)"

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

    # Write to AWS profile for CLI tools / subprocesses that don't inherit env vars
    # Profile name is just the env (e.g., "qat", "prod") - always readonly unless --admin
    command aws configure set aws_access_key_id "$AWS_ACCESS_KEY_ID" --profile "$env"
    command aws configure set aws_secret_access_key "$AWS_SECRET_ACCESS_KEY" --profile "$env"
    command aws configure set aws_session_token "$AWS_SESSION_TOKEN" --profile "$env"
    command aws configure set region "${AWS_REGION:-us-east-1}" --profile "$env"

    # Clear any profile setting (we're using explicit creds now)
    unset AWS_PROFILE

    # Track current access
    ASUDO_CURRENT_PROVIDER="aws"
    ASUDO_CURRENT_ENV="$env"
    ASUDO_CURRENT_LEVEL="$([[ "$admin" == "true" ]] && echo "admin" || echo "readonly")"
    export ASUDO_CURRENT_PROVIDER ASUDO_CURRENT_ENV ASUDO_CURRENT_LEVEL

    local expiry
    expiry=$(echo "$creds" | jq -r '.Credentials.Expiration')
    echo "AWS $env ($ASUDO_CURRENT_LEVEL) - expires: $expiry [profile: $env]"
}

_asudo_aws_clear() {
    unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
    _asudo_log "INFO" "aws credentials cleared"
}

# =============================================================================
# Azure
# =============================================================================

_asudo_azure_assume() {
    local env="$1"
    local admin="${2:-false}"

    local sub_id="${ASUDO_AZURE_SUBS[$env]:-}"
    if [[ -z "$sub_id" ]]; then
        # If no mapping, try using env as subscription name directly
        echo "No Azure subscription mapping for '$env', attempting to use as subscription name..." >&2
        if [[ "$admin" == "true" ]]; then
            _asudo_log "ADMIN" "azure $env (subscription name)"
        else
            _asudo_log "INFO" "azure $env (subscription name)"
        fi
        command az account set --subscription "$env"
    else
        if [[ "$admin" == "true" ]]; then
            _asudo_log "ADMIN" "azure $env ($sub_id)"
        else
            _asudo_log "INFO" "azure $env ($sub_id)"
        fi
        command az account set --subscription "$sub_id"
    fi

    if [[ $? -eq 0 ]]; then
        ASUDO_CURRENT_PROVIDER="azure"
        ASUDO_CURRENT_ENV="$env"
        ASUDO_CURRENT_LEVEL="$([[ "$admin" == "true" ]] && echo "admin" || echo "readonly")"
        export ASUDO_CURRENT_PROVIDER ASUDO_CURRENT_ENV ASUDO_CURRENT_LEVEL

        local current
        current=$(command az account show --query '{name:name, id:id}' -o tsv 2>/dev/null)
        echo "Azure: $current ($ASUDO_CURRENT_LEVEL)"
    fi
}

_asudo_azure_clear() {
    # Azure doesn't have a "clear" concept - you're always in some subscription
    # Best we can do is show warning
    echo "Azure: subscription context cannot be fully cleared" >&2
    echo "Consider: az logout (but this logs you out entirely)" >&2
}

# =============================================================================
# GCP
# =============================================================================

_asudo_gcp_assume() {
    local env="$1"
    local admin="${2:-false}"

    local project_id="${ASUDO_GCP_PROJECTS[$env]:-}"
    if [[ -z "$project_id" ]]; then
        # If no mapping, try using env as project directly
        echo "No GCP project mapping for '$env', attempting to use as project ID..." >&2
        project_id="$env"
    fi

    if [[ "$admin" == "true" ]]; then
        _asudo_log "ADMIN" "gcp $env ($project_id)"
    else
        _asudo_log "INFO" "gcp $env ($project_id)"
    fi

    command gcloud config set project "$project_id" 2>/dev/null

    if [[ $? -eq 0 ]]; then
        ASUDO_CURRENT_PROVIDER="gcp"
        ASUDO_CURRENT_ENV="$env"
        ASUDO_CURRENT_LEVEL="$([[ "$admin" == "true" ]] && echo "admin" || echo "readonly")"
        export ASUDO_CURRENT_PROVIDER ASUDO_CURRENT_ENV ASUDO_CURRENT_LEVEL

        echo "GCP: $project_id ($ASUDO_CURRENT_LEVEL)"
    fi
}

_asudo_gcp_clear() {
    command gcloud config unset project 2>/dev/null
    _asudo_log "INFO" "gcp project cleared"
}

# =============================================================================
# M365 (Microsoft Graph)
# =============================================================================

_asudo_m365_assume() {
    local level="${1:-personal}"

    _asudo_load_m365_config
    if [[ -z "$M365_CLIENT_ID" || -z "$M365_TENANT_ID" ]]; then
        echo "M365 config incomplete. Add m365-client-id and m365-tenant-id to BWS." >&2
        return 1
    fi

    local scopes
    case "$level" in
        personal|p)
            scopes="$M365_SCOPES_PERSONAL"
            level="personal"
            _asudo_log "INFO" "m365 personal access"
            ;;
        readonly|ro|r)
            scopes="$M365_SCOPES_READONLY"
            level="readonly"
            _asudo_log "INFO" "m365 readonly access"
            ;;
        admin|a)
            scopes="$M365_SCOPES_ADMIN"
            level="admin"
            _asudo_log "ADMIN" "m365 admin access"
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

    local auth_result
    if [[ -n "$M365_CLIENT_SECRET" ]]; then
        # App-only auth with client secret (bypasses user CA policies)
        echo "Using app-only authentication..."
        auth_result=$(pwsh -Command "
            \$secureSecret = ConvertTo-SecureString '$M365_CLIENT_SECRET' -AsPlainText -Force
            \$credential = New-Object System.Management.Automation.PSCredential('$M365_CLIENT_ID', \$secureSecret)
            try {
                Connect-MgGraph -TenantId '$M365_TENANT_ID' -ClientSecretCredential \$credential -NoWelcome
                \$ctx = Get-MgContext
                Write-Output \"SUCCESS|\$(\$ctx.AppName)|\$(\$ctx.TenantId)|\"
            } catch {
                Write-Output \"ERROR|\$_\"
            }
        " 2>&1)
    else
        # Delegated auth with device code (requires user sign-in)
        echo "Follow the device code instructions below."
        echo ""
        if pwsh -Command "Connect-MgGraph -ClientId '$M365_CLIENT_ID' -TenantId '$M365_TENANT_ID' -Scopes '$scope_array' -UseDeviceCode -ContextScope Process -NoWelcome"; then
            local account
            account=$(pwsh -Command "(Get-MgContext).Account" 2>/dev/null)
            auth_result="SUCCESS|$account||"
        else
            auth_result="ERROR|Device code authentication failed"
        fi
    fi

    if [[ "$auth_result" == SUCCESS* ]]; then
        local account_info
        account_info=$(echo "$auth_result" | cut -d'|' -f2)

        ASUDO_CURRENT_PROVIDER="m365"
        ASUDO_CURRENT_ENV="${account_info:-app-only}"
        ASUDO_CURRENT_LEVEL="$level"
        export ASUDO_CURRENT_PROVIDER ASUDO_CURRENT_ENV ASUDO_CURRENT_LEVEL

        echo ""
        echo "M365 $level - ${account_info:-app-only auth}"
    else
        echo "Failed to connect to Microsoft Graph:" >&2
        echo "$auth_result" | cut -d'|' -f2 >&2
        return 1
    fi
}

_asudo_m365_clear() {
    pwsh -Command "Disconnect-MgGraph" 2>/dev/null || true
    _asudo_log "INFO" "m365 disconnected"
}

_asudo_m365_status() {
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

asudo() {
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
            [[ -z "$env" ]] && { echo "Usage: asudo aws <env> [--admin]"; return 1; }
            _asudo_aws_assume "$env" "$admin"
            ;;
        azure|az)
            [[ -z "$env" ]] && { echo "Usage: asudo azure <subscription> [--admin]"; return 1; }
            _asudo_azure_assume "$env" "$admin"
            ;;
        gcp|gcloud)
            [[ -z "$env" ]] && { echo "Usage: asudo gcp <project> [--admin]"; return 1; }
            _asudo_gcp_assume "$env" "$admin"
            ;;
        m365|microsoft|ms)
            # M365 uses level instead of env: personal, readonly, admin
            local level="${env:-personal}"
            if [[ "$level" == "--admin" ]] || [[ "$admin" == "true" ]]; then
                level="admin"
            fi
            _asudo_m365_assume "$level"
            ;;
        clear|revoke)
            _asudo_aws_clear
            _asudo_azure_clear
            _asudo_gcp_clear
            _asudo_m365_clear
            unset ASUDO_CURRENT_PROVIDER ASUDO_CURRENT_ENV ASUDO_CURRENT_LEVEL
            echo "All service access cleared"
            ;;
        status|s)
            echo "=== asudo status ==="
            if [[ -n "${ASUDO_CURRENT_PROVIDER:-}" ]]; then
                echo "Active: $ASUDO_CURRENT_PROVIDER / $ASUDO_CURRENT_ENV ($ASUDO_CURRENT_LEVEL)"
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
            _asudo_m365_status
            ;;
        help|--help|-h)
            cat <<'EOF'
asudo - Unified service access control (like sudo for services)

Usage:
  asudo <provider> <environment> [--admin]
  asudo clear
  asudo status

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
  asudo aws qat           # readonly access to QAT
  asudo aws prod --admin  # admin access to prod (logged!)
  asudo azure dev         # switch to dev subscription
  asudo m365              # personal M365 access (mail, calendar)
  asudo m365 readonly     # tenant-wide read access
  asudo m365 admin        # full admin access (logged!)
  asudo clear             # revoke all access

Environment:
  ASUDO_AWS_SESSION_DURATION         Readonly session (default: 3600)
  ASUDO_AWS_ADMIN_SESSION_DURATION   Admin session (default: 900)
  ASUDO_ACCESS_LOG                   Log file path
EOF
            ;;
        "")
            echo "Usage: asudo <provider> <env> [--admin]"
            echo "       asudo status"
            echo "       asudo help"
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
    _asudo_assume_complete() {
        local -a providers envs flags
        providers=(aws azure gcp clear status help)
        flags=(--admin)

        case "${words[2]:-}" in
            aws)
                envs=(${(k)ASUDO_AWS_ACCOUNTS})
                _describe 'environment' envs
                _describe 'flags' flags
                ;;
            azure)
                envs=(${(k)ASUDO_AZURE_SUBS})
                _describe 'subscription' envs
                _describe 'flags' flags
                ;;
            gcp)
                envs=(${(k)ASUDO_GCP_PROJECTS})
                _describe 'project' envs
                _describe 'flags' flags
                ;;
            *)
                _describe 'provider' providers
                ;;
        esac
    }
    compdef _asudo_assume_complete asudo
fi

# Aliases for convenience
alias as='asudo'
alias asa='asudo aws'
alias asaz='asudo azure'
alias asg='asudo gcp'
alias asm='asudo m365'
