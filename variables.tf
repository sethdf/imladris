variable "aws_region" {
  description = "AWS region to deploy the devbox"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type - m7a.xlarge recommended for reliable dev work"
  type        = string
  default     = "m7a.xlarge"
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
# TAILSCALE
# =============================================================================

variable "tailscale_hostname" {
  description = "Hostname for this machine in Tailscale"
  type        = string
  default     = "devbox"
}

# =============================================================================
# ALL SECRETS FROM BITWARDEN
# =============================================================================
#
# Terraform pulls secrets via Bitwarden provider (see bitwarden.tf)
# BW credentials stored in lifemaestro/secrets/ (gitignored):
#   - bw-master, bw-client-id, bw-client-secret
#
# Required Bitwarden items:
#   - devbox/tailscale-auth-key (password field) - used at terraform apply
#   - devbox/tailscale-api-key  (password field) - API key for device cleanup
#   - devbox/luks-key           (password field) - LUKS encryption for data volume
#   - devbox/github-ssh-home    (custom field: private_key)
#   - devbox/github-ssh-work    (custom field: private_key)
#   - devbox/github-token       (password field)
#   - devbox/git-crypt-key      (custom field: key_b64)
#
# After first SSH login, run:
#   source ~/bin/bw-unlock    # Unlock Bitwarden vault
#   ~/bin/devbox-init         # Bootstrap remaining secrets
#
# =============================================================================
