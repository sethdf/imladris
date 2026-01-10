# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------

locals {
  # Map architecture to Ubuntu AMI naming convention
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
  description = "Security group for imladris instance - no public ingress, Tailscale handles access"
  vpc_id      = aws_vpc.imladris.id

  # No ingress rules - Tailscale handles all access via encrypted tunnel

  # Allow all outbound traffic (needed for Tailscale, package updates, etc.)
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
          "arn:aws:ec2:${var.aws_region}:*:volume/*",
          "arn:aws:ec2:${var.aws_region}:*:instance/*"
        ]
        Condition = {
          StringEquals = {
            "ec2:ResourceTag/Project" = "imladris"
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = "ec2:DescribeVolumes"
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
# User Data Template
# -----------------------------------------------------------------------------

locals {
  user_data_content = var.use_nix ? templatefile("${path.module}/scripts/user-data-nix.sh", {
    hostname           = var.hostname
    timezone           = var.schedule_timezone
    tailscale_auth_key = var.tailscale_auth_key
    tailscale_api_key  = var.tailscale_api_key
    tailscale_hostname = var.tailscale_hostname
    architecture       = var.architecture
    github_username    = var.github_username
    sns_topic_arn      = length(var.notification_emails) > 0 ? aws_sns_topic.imladris[0].arn : ""
    distro_id          = "ubuntu"
    distro_codename    = "noble"
    data_volume_tag    = "hall-of-fire"
  }) : templatefile("${path.module}/scripts/user-data-legacy.sh", {
    hostname           = var.hostname
    timezone           = var.schedule_timezone
    tailscale_auth_key = var.tailscale_auth_key
    tailscale_api_key  = var.tailscale_api_key
    tailscale_hostname = var.tailscale_hostname
    architecture       = var.architecture
    github_username    = var.github_username
    distro_id          = "ubuntu"
    distro_codename    = "noble"
    sns_topic_arn      = length(var.notification_emails) > 0 ? aws_sns_topic.imladris[0].arn : ""
    data_volume_tag    = "hall-of-fire"
  })
}

# -----------------------------------------------------------------------------
# EC2 Launch Template (used by Fleet)
# -----------------------------------------------------------------------------

resource "aws_launch_template" "imladris" {
  name_prefix   = "imladris-"
  image_id      = data.aws_ami.ubuntu.id

  iam_instance_profile {
    name = aws_iam_instance_profile.imladris.name
  }

  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.imladris.id]
    subnet_id                   = aws_subnet.imladris.id
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = var.volume_size
      volume_type           = "gp3"
      iops                  = var.volume_iops
      throughput            = var.volume_throughput
      delete_on_termination = true
      encrypted             = true
    }
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  user_data = base64gzip(local.user_data_content)

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name    = var.hostname
      Project = "imladris"
    }
  }

  tag_specifications {
    resource_type = "volume"
    tags = {
      Name    = "imladris-root"
      Backup  = "false"
      Project = "imladris"
    }
  }

  tags = {
    Name = "imladris-launch-template"
  }
}

# -----------------------------------------------------------------------------
# EC2 Fleet (capacity-optimized spot across multiple instance types)
# -----------------------------------------------------------------------------

resource "aws_ec2_fleet" "imladris" {
  count = var.use_fleet ? 1 : 0

  type                               = "maintain"
  terminate_instances                = true
  terminate_instances_with_expiration = true

  target_capacity_specification {
    default_target_capacity_type = var.use_spot ? "spot" : "on-demand"
    total_target_capacity        = 1
    spot_target_capacity         = var.use_spot ? 1 : 0
    on_demand_target_capacity    = var.use_spot ? 0 : 1
  }

  launch_template_config {
    launch_template_specification {
      launch_template_id = aws_launch_template.imladris.id
      version            = "$Latest"
    }

    # Generate overrides for each instance type in the fleet
    dynamic "override" {
      for_each = var.fleet_instance_types
      content {
        instance_type     = override.value
        availability_zone = data.aws_availability_zones.available.names[0]
      }
    }
  }

  spot_options {
    allocation_strategy            = "capacity-optimized"
    instance_interruption_behavior = "stop"
  }

  tags = {
    Name = "imladris-fleet"
  }

  lifecycle {
    ignore_changes = [launch_template_config]
  }
}

# -----------------------------------------------------------------------------
# EC2 Instance (fallback if not using fleet)
# -----------------------------------------------------------------------------

resource "aws_instance" "imladris" {
  count = var.use_fleet ? 0 : 1

  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.imladris.id
  vpc_security_group_ids = [aws_security_group.imladris.id]
  iam_instance_profile   = aws_iam_instance_profile.imladris.name

  hibernation = false

  dynamic "instance_market_options" {
    for_each = var.use_spot ? [1] : []
    content {
      market_type = "spot"
      spot_options {
        instance_interruption_behavior = "stop"
        spot_instance_type             = "persistent"
        max_price                      = var.spot_max_price != "" ? var.spot_max_price : null
      }
    }
  }

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
    prevent_destroy = false  # Set true after deploy
    ignore_changes  = [user_data_base64]
  }

  tags = {
    Name    = var.hostname
    Project = "imladris"
  }
}

# -----------------------------------------------------------------------------
# Data Volume (LUKS encrypted by user, not AWS)
# Self-attached by instance via user-data script (required for Fleet)
# -----------------------------------------------------------------------------

resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_availability_zones.available.names[0]
  size              = var.data_volume_size
  type              = "gp3"
  iops              = var.volume_iops
  throughput        = var.volume_throughput
  encrypted         = true # AWS encryption layer (LUKS adds user-controlled layer)

  tags = {
    Name    = "hall-of-fire"
    Backup  = "daily"
    Project = "imladris"
  }

  # Prevent accidental deletion - this volume contains LUKS-encrypted user data
  # NOTE: Set to false temporarily when intentionally destroying
  lifecycle {
    prevent_destroy = false  # Set true after deploy
  }
}

# Volume attachment handled by user-data script using AWS CLI
# This allows Fleet to attach volume to whatever instance it launches

# -----------------------------------------------------------------------------
# DLM Snapshot Policy (Daily backups)
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
  description        = "Hourly snapshots for imladris volume"
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

      retain_rule {
        count = 10
      }

      tags_to_add = {
        SnapshotCreator = "DLM"
        Project         = "imladris"
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

# -----------------------------------------------------------------------------
# Spot Auto-Restart (Lambda + EventBridge + SNS)
# -----------------------------------------------------------------------------

# SNS Topic for notifications (optional)
resource "aws_sns_topic" "imladris" {
  count = length(var.notification_emails) > 0 ? 1 : 0
  name  = "imladris-notifications"
}

resource "aws_sns_topic_subscription" "imladris_email" {
  for_each  = toset(var.notification_emails)
  topic_arn = aws_sns_topic.imladris[0].arn
  protocol  = "email"
  endpoint  = each.value
}

# IAM Role for Lambda (non-fleet mode only)
resource "aws_iam_role" "spot_restart" {
  count = var.use_spot && !var.use_fleet ? 1 : 0
  name  = "imladris-spot-restart-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "spot_restart" {
  count = var.use_spot && !var.use_fleet ? 1 : 0
  name  = "imladris-spot-restart-policy"
  role  = aws_iam_role.spot_restart[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ec2:StartInstances",
          "ec2:DescribeInstances"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "ec2:ResourceTag/Name" = var.hostname
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = "ec2:DescribeInstances"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = "sns:Publish"
        Resource = length(var.notification_emails) > 0 ? aws_sns_topic.imladris[0].arn : "*"
      }
    ]
  })
}

# Lambda function (only for non-fleet mode; Fleet auto-maintains capacity)
data "archive_file" "spot_restart" {
  count       = var.use_spot && !var.use_fleet ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/scripts/spot_restart.py"
  output_path = "${path.module}/.terraform/spot_restart.zip"
}

resource "aws_lambda_function" "spot_restart" {
  count            = var.use_spot && !var.use_fleet ? 1 : 0
  filename         = data.archive_file.spot_restart[0].output_path
  function_name    = "imladris-spot-restart"
  role             = aws_iam_role.spot_restart[0].arn
  handler          = "spot_restart.lambda_handler"
  source_code_hash = data.archive_file.spot_restart[0].output_base64sha256
  runtime          = "python3.12"
  timeout          = 300 # 5 minutes for retries

  environment {
    variables = {
      INSTANCE_ID   = var.use_fleet ? "" : aws_instance.imladris[0].id
      MAX_ATTEMPTS  = tostring(var.spot_restart_attempts)
      SNS_TOPIC_ARN = length(var.notification_emails) > 0 ? aws_sns_topic.imladris[0].arn : ""
    }
  }

  tags = {
    Name = "imladris-spot-restart"
  }
}

# EventBridge rule to trigger on instance state change (non-fleet mode only)
resource "aws_cloudwatch_event_rule" "spot_restart" {
  count       = var.use_spot && !var.use_fleet ? 1 : 0
  name        = "imladris-spot-restart"
  description = "Trigger restart when imladris instance is stopped (spot interruption)"

  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    detail-type = ["EC2 Instance State-change Notification"]
    detail = {
      state       = ["stopped"]
      instance-id = [aws_instance.imladris[0].id]
    }
  })
}

resource "aws_cloudwatch_event_target" "spot_restart" {
  count     = var.use_spot && !var.use_fleet ? 1 : 0
  rule      = aws_cloudwatch_event_rule.spot_restart[0].name
  target_id = "imladris-spot-restart"
  arn       = aws_lambda_function.spot_restart[0].arn
}

resource "aws_lambda_permission" "spot_restart" {
  count         = var.use_spot && !var.use_fleet ? 1 : 0
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.spot_restart[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.spot_restart[0].arn
}

# -----------------------------------------------------------------------------
# Scheduled Start/Stop (EventBridge Scheduler)
# -----------------------------------------------------------------------------

# IAM Role for EventBridge Scheduler (non-fleet mode only)
resource "aws_iam_role" "scheduler" {
  count = var.enable_schedule && !var.use_fleet ? 1 : 0
  name  = "imladris-scheduler-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "scheduler.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  count = var.enable_schedule && !var.use_fleet ? 1 : 0
  name  = "imladris-scheduler-policy"
  role  = aws_iam_role.scheduler[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ec2:StartInstances",
          "ec2:StopInstances"
        ]
        Resource = aws_instance.imladris[0].arn
      }
    ]
  })
}

# Schedule: Stop at 11pm Mountain (non-fleet mode only)
resource "aws_scheduler_schedule" "stop" {
  count       = var.enable_schedule && !var.use_fleet ? 1 : 0
  name        = "imladris-stop"
  description = "Stop imladris instance at night"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "cron(${var.schedule_stop})"
  schedule_expression_timezone = var.schedule_timezone

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:stopInstances"
    role_arn = aws_iam_role.scheduler[0].arn

    input = jsonencode({
      InstanceIds = [aws_instance.imladris[0].id]
      # Hibernate disabled for security - RAM would expose LUKS keys
    })
  }
}

# Schedule: Start at 5am Mountain (non-fleet mode only)
resource "aws_scheduler_schedule" "start" {
  count       = var.enable_schedule && !var.use_fleet ? 1 : 0
  name        = "imladris-start"
  description = "Start imladris instance in the morning"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "cron(${var.schedule_start})"
  schedule_expression_timezone = var.schedule_timezone

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:startInstances"
    role_arn = aws_iam_role.scheduler[0].arn

    input = jsonencode({
      InstanceIds = [aws_instance.imladris[0].id]
    })
  }
}
