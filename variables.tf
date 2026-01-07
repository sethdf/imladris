variable "aws_region" {
  description = "AWS region to deploy the devbox"
  type        = string
  default     = "us-east-1"
}

variable "architecture" {
  description = "CPU architecture: arm64 (Graviton, recommended) or x86_64"
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.architecture)
    error_message = "Architecture must be 'arm64' or 'x86_64'."
  }
}

variable "instance_type" {
  description = <<-EOT
    EC2 instance type for the devbox.

    Recommended Graviton (arm64) types in order of preference:
      1. m7g.xlarge  - Latest gen, best performance (default)
      2. m6g.xlarge  - Previous gen, often better spot availability
      3. c7g.xlarge  - Compute optimized, good for builds
      4. r7g.large   - Memory optimized, 2 vCPU but 16GB RAM

    If spot capacity is unavailable, try the next type in the list.
    Run 'make spot-check' to verify availability before deploying.
  EOT
  type        = string
  default     = "m7g.xlarge"

  validation {
    condition = can(regex("^[a-z][0-9][a-z]?g?\\.(nano|micro|small|medium|large|xlarge|[0-9]+xlarge)$", var.instance_type))
    error_message = "Instance type must be a valid EC2 instance type format."
  }
}

variable "instance_type_fallbacks" {
  description = <<-EOT
    Fallback instance types if primary has no spot capacity.
    Used by 'make spot-check' to show availability across types.
    For manual fallback: set instance_type to one of these.
  EOT
  type    = list(string)
  default = ["m6g.xlarge", "c7g.xlarge", "r7g.large"]
}

variable "volume_size" {
  description = "Root EBS volume size in GB"
  type        = number
  default     = 50
}

variable "data_volume_size" {
  description = "Data EBS volume size in GB (LUKS encrypted)"
  type        = number
  default     = 100
}

variable "volume_iops" {
  description = "EBS gp3 IOPS (3000 is baseline)"
  type        = number
  default     = 3000
}

variable "volume_throughput" {
  description = "EBS gp3 throughput in MiB/s (default 125, recommended 250)"
  type        = number
  default     = 250
}

variable "hostname" {
  description = "Hostname for the devbox"
  type        = string
  default     = "aws-dev-box"
}

variable "snapshot_retention_days" {
  description = "Number of days to retain daily EBS snapshots"
  type        = number
  default     = 7
}

variable "use_spot" {
  description = "Use spot instances for ~70% cost savings"
  type        = bool
  default     = true
}

variable "spot_max_price" {
  description = "Maximum hourly price for spot (empty = on-demand price cap)"
  type        = string
  default     = ""
}

variable "notification_emails" {
  description = "Emails for spot interruption notifications"
  type        = list(string)
  default     = []
}

variable "spot_restart_attempts" {
  description = "Number of times to retry starting spot before giving up"
  type        = number
  default     = 5
}

variable "schedule_stop" {
  description = "Cron expression for auto-stop (e.g., '0 23 * * ? *' for 11pm)"
  type        = string
  default     = "0 23 * * ? *"
}

variable "schedule_start" {
  description = "Cron expression for auto-start (e.g., '0 5 * * ? *' for 5am)"
  type        = string
  default     = "0 5 * * ? *"
}

variable "schedule_timezone" {
  description = "Timezone for schedule (e.g., 'America/Denver' for Mountain)"
  type        = string
  default     = "America/Denver"
}

variable "enable_schedule" {
  description = "Enable automatic start/stop schedule"
  type        = bool
  default     = true
}

# =============================================================================
# BITWARDEN SECRETS MANAGER
# =============================================================================
# No variables needed - authentication via access token in:
#   lifemaestro/secrets/bw-sm-access-token

# =============================================================================
# GITHUB
# =============================================================================

variable "github_username" {
  description = "GitHub username for cloning bootstrap scripts"
  type        = string
  # No default - must be provided in terraform.tfvars
}

# =============================================================================
# TAILSCALE
# =============================================================================

variable "tailscale_hostname" {
  description = "Hostname for this machine in Tailscale"
  type        = string
  default     = "devbox"
}

# =============================================================================
# ALL SECRETS FROM BITWARDEN SECRETS MANAGER
# =============================================================================
#
# Terraform pulls secrets via Bitwarden Secrets Manager provider (see bitwarden.tf)
# Access token stored in lifemaestro/secrets/bw-sm-access-token (gitignored)
#
# Required secrets in Secrets Manager (create in "devbox" project):
#
#   Used by Terraform at apply time:
#   - tailscale-auth-key    : Auth key for joining tailnet
#   - tailscale-api-key     : API key for device cleanup
#
#   Used by devbox-init.sh at runtime:
#   - luks-key              : LUKS encryption passphrase for data volume
#   - github-ssh-home       : SSH private key (base64 encoded)
#   - github-ssh-work       : SSH private key (base64 encoded)
#   - github-token          : GitHub PAT for gh CLI
#   - git-crypt-key         : git-crypt key (base64 encoded)
#   - github-home-name      : Git author name for home
#   - github-home-email     : Git author email for home
#   - github-home-username  : GitHub username
#   - github-work-name      : Git author name for work
#   - github-work-email     : Git author email for work
#   - aws-access-key-id     : AWS access key (optional)
#   - aws-secret-access-key : AWS secret key (optional)
#   - gmail-client-id       : Gmail OAuth client ID (optional)
#   - gmail-client-secret   : Gmail OAuth client secret (optional)
#   - ms365-client-id       : MS365 OAuth client ID (optional)
#   - ms365-client-secret   : MS365 OAuth client secret (optional)
#   - ms365-tenant-id       : MS365 tenant ID (optional)
#
# After first SSH login, run:
#   ~/bin/devbox-init         # Bootstrap remaining secrets from Secrets Manager
#
# =============================================================================
