# =============================================================================
# Imladris AMI Bake Template
# =============================================================================
# Builds a pre-configured AMI with all deterministic packages and tools.
# Eliminates 3-4/9 deploy failure categories (Docker GPG, Bun download,
# Node.js timeout, mosh source build). Reduces deploy time from 8-45min
# to ~3-5min.
#
# Usage (via build-ami.sh):
#   packer init packer/imladris.pkr.hcl
#   packer build -var-file=packer/vars.auto.pkrvars.hcl packer/imladris.pkr.hcl
#
# Or directly:
#   packer build \
#     -var vpc_id=vpc-xxx \
#     -var subnet_id=subnet-xxx \
#     -var kms_key_id=arn:aws:kms:... \
#     packer/imladris.pkr.hcl

packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

# --- Variables ---

variable "vpc_id" {
  type        = string
  description = "VPC ID for the build instance (from CF stack output)"
}

variable "subnet_id" {
  type        = string
  description = "Subnet ID for the build instance (from CF stack output)"
}

variable "kms_key_id" {
  type        = string
  description = "KMS key ARN for encrypting the AMI (Decision 30)"
}

variable "instance_type" {
  type        = string
  default     = "m7g.large"
  description = "Build instance type (ARM, no NVMe needed — cheaper than m7gd)"
}

variable "region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region for the build"
}

variable "iam_instance_profile" {
  type        = string
  default     = "ImladrisWorkstationProfile"
  description = "IAM instance profile (needs KMS permissions for encrypted AMI)"
}

variable "repo_url" {
  type        = string
  default     = "https://github.com/sethdf/imladris.git"
  description = "Git repository URL for Ansible playbooks"
}

# --- Source AMI lookup (AL2023 ARM — same base as CF) ---

data "amazon-ami" "al2023_arm" {
  filters = {
    name                = "al2023-ami-*-kernel-*-arm64"
    root-device-type    = "ebs"
    virtualization-type = "hvm"
    architecture        = "arm64"
  }
  most_recent = true
  owners      = ["amazon"]
  region      = var.region
}

# --- Builder ---

source "amazon-ebs" "imladris" {
  region        = var.region
  instance_type = var.instance_type
  source_ami    = data.amazon-ami.al2023_arm.id

  # Network — use existing VPC/subnet from CF stack
  vpc_id    = var.vpc_id
  subnet_id = var.subnet_id
  associate_public_ip_address = true

  # IAM — needs KMS permissions for encrypted volumes
  iam_instance_profile = var.iam_instance_profile

  # Encryption (Decision 30) — same CMK as EBS volumes
  encrypt_boot = true
  kms_key_id   = var.kms_key_id

  # AMI configuration
  ami_name        = "imladris-{{timestamp}}"
  ami_description = "Imladris cloud workstation - pre-baked with packages, Docker, Bun, Node.js, Claude Code CLI"

  ami_users = []  # Private AMI

  tags = {
    Name       = "imladris-{{timestamp}}"
    Project    = "Imladris"
    SourceAmi  = "{{ .SourceAMI }}"
    BuiltAt    = "{{timestamp}}"
    BuildType  = "packer"
  }

  run_tags = {
    Name    = "Packer-Imladris-Builder"
    Project = "Imladris"
  }

  # SSH configuration
  ssh_username = "ec2-user"

  # Build timeout
  aws_polling {
    delay_seconds = 15
    max_attempts  = 120  # 30 minutes max for AMI creation
  }
}

# --- Build steps ---

build {
  sources = ["source.amazon-ebs.imladris"]

  # Step 1: Install Ansible
  provisioner "shell" {
    inline = [
      "sudo dnf install -y python3-pip git",
      "sudo pip3 install ansible-core",
      "ansible-galaxy collection install ansible.posix",
    ]
  }

  # Step 2: Clone imladris repo (needed for Ansible roles and templates)
  provisioner "shell" {
    inline = [
      "mkdir -p /home/ec2-user/repos",
      "git clone ${var.repo_url} /home/ec2-user/repos/imladris",
    ]
  }

  # Step 3: Run bake playbook
  provisioner "shell" {
    inline = [
      "cd /home/ec2-user/repos/imladris/ansible",
      "ansible-playbook site-bake.yml --limit imladris-local",
    ]
  }

  # Step 4: Cleanup (remove SSH keys, logs, temp files, repo clone)
  provisioner "shell" {
    script = "packer/scripts/cleanup.sh"
  }
}
