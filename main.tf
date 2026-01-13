# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------

locals {
  ami_arch = var.architecture == "arm64" ? "arm64" : "amd64"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${local.ami_arch}-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "architecture"
    values = [var.architecture]
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------

resource "aws_vpc" "imladris" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "imladris-vpc"
  }
}

resource "aws_subnet" "imladris" {
  vpc_id                  = aws_vpc.imladris.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name = "imladris-subnet"
  }
}

resource "aws_internet_gateway" "imladris" {
  vpc_id = aws_vpc.imladris.id

  tags = {
    Name = "imladris-igw"
  }
}

resource "aws_route_table" "imladris" {
  vpc_id = aws_vpc.imladris.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.imladris.id
  }

  tags = {
    Name = "imladris-rt"
  }
}

resource "aws_route_table_association" "imladris" {
  subnet_id      = aws_subnet.imladris.id
  route_table_id = aws_route_table.imladris.id
}

# -----------------------------------------------------------------------------
# Security Group
# -----------------------------------------------------------------------------

resource "aws_security_group" "imladris" {
  name        = "imladris-sg"
  description = "Security group for imladris - no public ingress, Tailscale handles access"
  vpc_id      = aws_vpc.imladris.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "imladris-sg"
  }
}

# -----------------------------------------------------------------------------
# IAM Instance Profile (for EBS self-attachment)
# -----------------------------------------------------------------------------

resource "aws_iam_role" "imladris_instance" {
  name = "imladris-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "imladris_ebs" {
  name = "imladris-ebs-attach"
  role = aws_iam_role.imladris_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ec2:AttachVolume",
          "ec2:DetachVolume"
        ]
        Resource = [
          "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:volume/*",
          "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*"
        ]
        Condition = {
          StringEquals = {
            "ec2:ResourceTag/Project" = "imladris"
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:DescribeVolumes",
          "ec2:DescribeInstances"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "imladris" {
  name = "imladris-instance-profile"
  role = aws_iam_role.imladris_instance.name
}

# -----------------------------------------------------------------------------
# User Data
# -----------------------------------------------------------------------------

locals {
  user_data_content = templatefile("${path.module}/scripts/user-data-nix.sh", {
    hostname           = var.hostname
    timezone           = var.schedule_timezone
    tailscale_auth_key = var.tailscale_auth_key
    tailscale_api_key  = var.tailscale_api_key
    tailscale_hostname = var.tailscale_hostname
    architecture       = var.architecture
    github_username    = var.github_username
    sns_topic_arn      = ""
    distro_id          = "ubuntu"
    distro_codename    = "noble"
    data_volume_tag    = "hall-of-fire"
  })
}

# -----------------------------------------------------------------------------
# EC2 Instance
# -----------------------------------------------------------------------------

resource "aws_instance" "imladris" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.imladris.id
  vpc_security_group_ids = [aws_security_group.imladris.id]
  iam_instance_profile   = aws_iam_instance_profile.imladris.name

  root_block_device {
    volume_size           = var.volume_size
    volume_type           = "gp3"
    iops                  = var.volume_iops
    throughput            = var.volume_throughput
    delete_on_termination = true
    encrypted             = true

    tags = {
      Name    = "imladris-root"
      Backup  = "false"
      Project = "imladris"
    }
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  user_data_base64 = base64gzip(local.user_data_content)

  lifecycle {
    ignore_changes = [user_data_base64]
  }

  tags = {
    Name    = var.hostname
    Project = "imladris"
  }
}

# -----------------------------------------------------------------------------
# Data Volume (LUKS encrypted)
# -----------------------------------------------------------------------------

resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_availability_zones.available.names[0]
  size              = var.data_volume_size
  type              = "gp3"
  iops              = var.volume_iops
  throughput        = var.volume_throughput
  encrypted         = true

  tags = {
    Name    = "hall-of-fire"
    Backup  = "daily"
    Project = "imladris"
  }
}

# -----------------------------------------------------------------------------
# DLM Snapshot Policy (Hourly backups)
# -----------------------------------------------------------------------------

resource "aws_iam_role" "dlm" {
  name = "imladris-dlm-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "dlm.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "imladris" {
  description        = "Hourly snapshots for imladris data volume"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    schedule {
      name = "Hourly snapshots"

      create_rule {
        interval      = 1
        interval_unit = "HOURS"
      }

      # Retain 24 hourly snapshots (24 hours of protection)
      retain_rule {
        count = 24
      }

      tags_to_add = {
        SnapshotCreator = "DLM"
        Project         = "imladris"
        SnapshotType    = "hourly"
      }

      copy_tags = true
    }

    target_tags = {
      Backup = "daily"
    }
  }

  tags = {
    Name = "imladris-dlm-policy"
  }
}
