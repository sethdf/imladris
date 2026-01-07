# =============================================================================
# BITWARDEN SECRETS MANAGER - Fetches secrets from Secrets Manager
# =============================================================================
#
# Setup:
#   1. Enable Secrets Manager in your Bitwarden organization
#   2. Create a project (e.g., "devbox")
#   3. Create a machine account with access to the project
#   4. Generate an access token for the machine account
#   5. Store credentials in lifemaestro/secrets/ (gitignored):
#      - bw-sm-access-token  : Machine account access token
#      - bw-sm-org-id        : Organization ID (from BW admin console)
#
# Required secrets in Secrets Manager (create in "devbox" project):
#   - tailscale-auth-key    : Tailscale auth key for joining tailnet
#   - tailscale-api-key     : Tailscale API key for device cleanup
#
# =============================================================================

locals {
  bw_secrets_path = "${path.module}/../../lifemaestro/secrets"
}

provider "bitwarden-secrets" {
  access_token = trimspace(file("${local.bw_secrets_path}/bw-sm-access-token"))
}

# Get list of all secrets to enable lookup by name
data "bitwarden-secrets_list_secrets" "all" {}

# Create a map of secret key -> id for lookups
locals {
  secrets_by_name = { for s in data.bitwarden-secrets_list_secrets.all.secrets : s.key => s.id }
}

# Tailscale auth key for devbox to join tailnet
data "bitwarden-secrets_secret" "tailscale" {
  id = local.secrets_by_name["tailscale-auth-key"]
}

# Tailscale API key for device cleanup
data "bitwarden-secrets_secret" "tailscale_api" {
  id = local.secrets_by_name["tailscale-api-key"]
}
