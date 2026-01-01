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

resource "aws_vpc" "devbox" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "devbox-vpc"
  }
}

resource "aws_subnet" "devbox" {
  vpc_id                  = aws_vpc.devbox.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name = "devbox-subnet"
  }
}

resource "aws_internet_gateway" "devbox" {
  vpc_id = aws_vpc.devbox.id

  tags = {
    Name = "devbox-igw"
  }
}

resource "aws_route_table" "devbox" {
  vpc_id = aws_vpc.devbox.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.devbox.id
  }

  tags = {
    Name = "devbox-rt"
  }
}

resource "aws_route_table_association" "devbox" {
  subnet_id      = aws_subnet.devbox.id
  route_table_id = aws_route_table.devbox.id
}

# -----------------------------------------------------------------------------
# Security Group
# -----------------------------------------------------------------------------

resource "aws_security_group" "devbox" {
  name        = "devbox-sg"
  description = "Security group for devbox instance - no public ingress, Tailscale handles access"
  vpc_id      = aws_vpc.devbox.id

  # No ingress rules - Tailscale handles all access via encrypted tunnel

  # Allow all outbound traffic (needed for Tailscale, package updates, etc.)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "devbox-sg"
  }
}

# -----------------------------------------------------------------------------
# EC2 Instance
# -----------------------------------------------------------------------------

resource "aws_instance" "devbox" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.devbox.id
  vpc_security_group_ids = [aws_security_group.devbox.id]

  # Hibernation disabled - RAM dumps to root EBS would expose LUKS keys
  # Trade-off: Lose running state on stop, but disk data stays secure
  hibernation = false

  # Spot instance configuration (optional)
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
      Name   = "devbox-root"
      Backup = "false"
    }
  }

  # Require IMDSv2 for enhanced security
  metadata_options {
    http_tokens   = "required"  # Require IMDSv2 token
    http_endpoint = "enabled"
  }

  # User data - Tailscale auth key from Bitwarden
  # All other secrets bootstrapped from Bitwarden after first login
  # Compressed with gzip (AWS auto-decompresses) to stay under 16KB limit
  user_data_base64 = base64gzip(templatefile("${path.module}/scripts/user-data.sh", {
    hostname            = var.hostname
    timezone            = var.schedule_timezone
    tailscale_auth_key  = data.bitwarden_item_login.tailscale.password
    tailscale_api_key   = data.bitwarden_item_login.tailscale_api.password
    tailscale_hostname  = var.tailscale_hostname
    architecture        = var.architecture
    github_username     = var.github_username
    distro_id           = "ubuntu"
    distro_codename     = "noble"
    sns_topic_arn       = length(var.notification_emails) > 0 ? aws_sns_topic.devbox[0].arn : ""
  }))

  # Don't recreate instance if user-data changes
  lifecycle {
    ignore_changes = [user_data_base64]
  }

  tags = {
    Name = var.hostname
  }
}

# -----------------------------------------------------------------------------
# Data Volume (LUKS encrypted by user, not AWS)
# -----------------------------------------------------------------------------

resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_availability_zones.available.names[0]
  size              = var.data_volume_size
  type              = "gp3"
  iops              = var.volume_iops
  throughput        = var.volume_throughput
  encrypted         = true # AWS encryption layer (LUKS adds user-controlled layer)

  tags = {
    Name   = "devbox-data"
    Backup = "daily"
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.devbox.id
}

# -----------------------------------------------------------------------------
# DLM Snapshot Policy (Daily backups)
# -----------------------------------------------------------------------------

resource "aws_iam_role" "dlm" {
  name = "devbox-dlm-role"

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

resource "aws_dlm_lifecycle_policy" "devbox" {
  description        = "Daily snapshots for devbox volume"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    schedule {
      name = "Daily snapshots"

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"] # 3 AM UTC
      }

      retain_rule {
        count = var.snapshot_retention_days
      }

      tags_to_add = {
        SnapshotCreator = "DLM"
        Project         = "aws-devbox"
      }

      copy_tags = true
    }

    target_tags = {
      Backup = "daily"
    }
  }

  tags = {
    Name = "devbox-dlm-policy"
  }
}

# -----------------------------------------------------------------------------
# Spot Auto-Restart (Lambda + EventBridge + SNS)
# -----------------------------------------------------------------------------

# SNS Topic for notifications (optional)
resource "aws_sns_topic" "devbox" {
  count = length(var.notification_emails) > 0 ? 1 : 0
  name  = "devbox-notifications"
}

resource "aws_sns_topic_subscription" "devbox_email" {
  for_each  = toset(var.notification_emails)
  topic_arn = aws_sns_topic.devbox[0].arn
  protocol  = "email"
  endpoint  = each.value
}

# IAM Role for Lambda
resource "aws_iam_role" "spot_restart" {
  count = var.use_spot ? 1 : 0
  name  = "devbox-spot-restart-role"

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
  count = var.use_spot ? 1 : 0
  name  = "devbox-spot-restart-policy"
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
        Resource = length(var.notification_emails) > 0 ? aws_sns_topic.devbox[0].arn : "*"
      }
    ]
  })
}

# Lambda function
data "archive_file" "spot_restart" {
  count       = var.use_spot ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/scripts/spot_restart.py"
  output_path = "${path.module}/.terraform/spot_restart.zip"
}

resource "aws_lambda_function" "spot_restart" {
  count            = var.use_spot ? 1 : 0
  filename         = data.archive_file.spot_restart[0].output_path
  function_name    = "devbox-spot-restart"
  role             = aws_iam_role.spot_restart[0].arn
  handler          = "spot_restart.lambda_handler"
  source_code_hash = data.archive_file.spot_restart[0].output_base64sha256
  runtime          = "python3.12"
  timeout          = 300 # 5 minutes for retries

  environment {
    variables = {
      INSTANCE_ID   = aws_instance.devbox.id
      MAX_ATTEMPTS  = tostring(var.spot_restart_attempts)
      SNS_TOPIC_ARN = length(var.notification_emails) > 0 ? aws_sns_topic.devbox[0].arn : ""
    }
  }

  tags = {
    Name = "devbox-spot-restart"
  }
}

# EventBridge rule to trigger on instance state change
resource "aws_cloudwatch_event_rule" "spot_restart" {
  count       = var.use_spot ? 1 : 0
  name        = "devbox-spot-restart"
  description = "Trigger restart when devbox instance is stopped (spot interruption)"

  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    detail-type = ["EC2 Instance State-change Notification"]
    detail = {
      state       = ["stopped"]
      instance-id = [aws_instance.devbox.id]
    }
  })
}

resource "aws_cloudwatch_event_target" "spot_restart" {
  count     = var.use_spot ? 1 : 0
  rule      = aws_cloudwatch_event_rule.spot_restart[0].name
  target_id = "devbox-spot-restart"
  arn       = aws_lambda_function.spot_restart[0].arn
}

resource "aws_lambda_permission" "spot_restart" {
  count         = var.use_spot ? 1 : 0
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.spot_restart[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.spot_restart[0].arn
}

# -----------------------------------------------------------------------------
# Scheduled Start/Stop (EventBridge Scheduler)
# -----------------------------------------------------------------------------

# IAM Role for EventBridge Scheduler
resource "aws_iam_role" "scheduler" {
  count = var.enable_schedule ? 1 : 0
  name  = "devbox-scheduler-role"

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
  count = var.enable_schedule ? 1 : 0
  name  = "devbox-scheduler-policy"
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
        Resource = aws_instance.devbox.arn
      }
    ]
  })
}

# Schedule: Stop at 11pm Mountain
resource "aws_scheduler_schedule" "stop" {
  count       = var.enable_schedule ? 1 : 0
  name        = "devbox-stop"
  description = "Stop devbox instance at night"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "cron(${var.schedule_stop})"
  schedule_expression_timezone = var.schedule_timezone

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:stopInstances"
    role_arn = aws_iam_role.scheduler[0].arn

    input = jsonencode({
      InstanceIds = [aws_instance.devbox.id]
      # Hibernate disabled for security - RAM would expose LUKS keys
    })
  }
}

# Schedule: Start at 5am Mountain
resource "aws_scheduler_schedule" "start" {
  count       = var.enable_schedule ? 1 : 0
  name        = "devbox-start"
  description = "Start devbox instance in the morning"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "cron(${var.schedule_start})"
  schedule_expression_timezone = var.schedule_timezone

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:startInstances"
    role_arn = aws_iam_role.scheduler[0].arn

    input = jsonencode({
      InstanceIds = [aws_instance.devbox.id]
    })
  }
}
