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
  default     = "m7g.xlarge"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*\\.[a-z0-9]+$", var.instance_type))
    error_message = "Instance type must be in format 'family.size' (e.g., t4g.large, m7a.xlarge)."
  }
}

variable "volume_size" {
  description = "Root EBS volume size in GB"
  type        = number
  default     = 50

  validation {
    condition     = var.volume_size >= 20 && var.volume_size <= 16384
    error_message = "Root volume size must be between 20 and 16384 GB."
  }
}

variable "data_volume_size" {
  description = "Data EBS volume size in GB (LUKS encrypted)"
  type        = number
  default     = 100

  validation {
    condition     = var.data_volume_size >= 50 && var.data_volume_size <= 16384
    error_message = "Data volume size must be between 50 and 16384 GB."
  }
}

variable "volume_iops" {
  description = "EBS gp3 IOPS"
  type        = number
  default     = 3000

  validation {
    condition     = var.volume_iops >= 3000 && var.volume_iops <= 16000
    error_message = "gp3 IOPS must be between 3000 and 16000."
  }
}

variable "volume_throughput" {
  description = "EBS gp3 throughput in MiB/s"
  type        = number
  default     = 250

  validation {
    condition     = var.volume_throughput >= 125 && var.volume_throughput <= 1000
    error_message = "gp3 throughput must be between 125 and 1000 MiB/s."
  }
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
