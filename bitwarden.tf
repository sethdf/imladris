# =============================================================================
# BITWARDEN PROVIDER - Fetches secrets from vault
# =============================================================================
#
# Credentials stored in lifemaestro/secrets/ (gitignored):
#   - bw-master       : Master password
#   - bw-client-id    : API client ID (user.xxx...)
#   - bw-client-secret: API client secret
#
# Get API key from: https://vault.bitwarden.com
#   Settings > Security > Keys > View API Key
# =============================================================================

locals {
  bw_secrets_path = "${path.module}/../../lifemaestro/secrets"
}

provider "bitwarden" {
  email           = var.bitwarden_email
  master_password = trimspace(file("${local.bw_secrets_path}/bw-master"))
  client_id       = trimspace(file("${local.bw_secrets_path}/bw-client-id"))
  client_secret   = trimspace(file("${local.bw_secrets_path}/bw-client-secret"))
}

# Tailscale auth key for devbox to join tailnet (dacapo folder)
data "bitwarden_item_login" "tailscale" {
  search = "tailscale-auth-key"
}

# Tailscale API key for device cleanup (dacapo folder)
data "bitwarden_item_login" "tailscale_api" {
  search = "tailscale-api-key"
}
