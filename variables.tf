variable "aws_region" {
  description = "AWS region to deploy the imladris"
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
    EC2 instance type for the imladris.

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
    condition     = can(regex("^[a-z][0-9][a-z]?g?\\.(nano|micro|small|medium|large|xlarge|[0-9]+xlarge)$", var.instance_type))
    error_message = "Instance type must be a valid EC2 instance type format."
  }
}

variable "instance_type_fallbacks" {
  description = <<-EOT
    Fallback instance types if primary has no spot capacity.
    Used by 'make spot-check' to show availability across types.
    For manual fallback: set instance_type to one of these.
  EOT
  type        = list(string)
  default     = ["m6g.xlarge", "c7g.xlarge", "r7g.large"]
}

variable "fleet_instance_types" {
  description = <<-EOT
    Instance types for EC2 Fleet to choose from (capacity-optimized).
    Fleet automatically picks the type with best spot availability.
    Order matters for capacity-optimized-prioritized strategy.
  EOT
  type        = list(string)
  default     = ["t4g.large", "t4g.xlarge", "m6g.large", "m6g.xlarge", "m7g.large", "m7g.xlarge"]
}

variable "use_fleet" {
  description = "Use EC2 Fleet for better spot availability across instance types"
  type        = bool
  default     = true
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
  description = "Hostname for the imladris"
  type        = string
  default     = "imladris"
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
# BUILD MODE
# =============================================================================

variable "use_nix" {
  description = "Use Nix + home-manager for package management (recommended)"
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
  description = "GitHub username for cloning bootstrap scripts and skills"
  type        = string
  # No default - must be provided in terraform.tfvars
}

# =============================================================================
# TAILSCALE
# =============================================================================

variable "tailscale_hostname" {
  description = "Hostname for this machine in Tailscale"
  type        = string
  default     = "imladris"
}

# =============================================================================
# SECRETS (pass via TF_VAR_ env vars or terraform.tfvars)
# =============================================================================
# Fetch from bws before running terraform:
#   export TF_VAR_tailscale_auth_key=$(bws secret get <id> | jq -r .value)
#   export TF_VAR_tailscale_api_key=$(bws secret get <id> | jq -r .value)
# =============================================================================

variable "tailscale_auth_key" {
  description = "Tailscale auth key for joining tailnet"
  type        = string
  sensitive   = true
}

variable "tailscale_api_key" {
  description = "Tailscale API key for device cleanup"
  type        = string
  sensitive   = true
}
