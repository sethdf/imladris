variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "architecture" {
  description = "CPU architecture: arm64 (Graviton) or x86_64"
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.architecture)
    error_message = "Architecture must be 'arm64' or 'x86_64'."
  }
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t4g.large"
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
  description = "EBS gp3 IOPS"
  type        = number
  default     = 3000
}

variable "volume_throughput" {
  description = "EBS gp3 throughput in MiB/s"
  type        = number
  default     = 250
}

variable "hostname" {
  description = "Hostname for the instance"
  type        = string
  default     = "imladris"
}

variable "schedule_timezone" {
  description = "Timezone for display"
  type        = string
  default     = "America/Denver"
}

# -----------------------------------------------------------------------------
# GitHub
# -----------------------------------------------------------------------------

variable "github_username" {
  description = "GitHub username for cloning bootstrap scripts"
  type        = string
}

# -----------------------------------------------------------------------------
# Tailscale
# -----------------------------------------------------------------------------

variable "tailscale_hostname" {
  description = "Hostname in Tailscale"
  type        = string
  default     = "imladris"
}

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
