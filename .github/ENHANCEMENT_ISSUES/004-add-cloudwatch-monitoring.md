# Add CloudWatch Monitoring and Alerting

## Summary
Implement CloudWatch monitoring with alarms for instance health, disk usage, and system metrics to proactively detect issues.

## Current State
- No CloudWatch alarms configured
- SNS topic exists for spot interruption notifications only
- Basic EC2 metrics collected by default but not monitored
- No visibility into disk space, memory, or application health

## Proposed Implementation

### 1. CloudWatch Agent Installation
Add to `user-data.sh`:
```bash
# Install CloudWatch agent
wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb
dpkg -i amazon-cloudwatch-agent.deb

# Configure for disk, memory, and process metrics
```

### 2. Instance Health Alarms
```hcl
resource "aws_cloudwatch_metric_alarm" "instance_status_check" {
  alarm_name          = "devbox-instance-status-check"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_actions       = [aws_sns_topic.devbox_alerts.arn]
}
```

### 3. Disk Usage Alarms
```hcl
resource "aws_cloudwatch_metric_alarm" "root_disk_usage" {
  alarm_name  = "devbox-root-disk-high"
  metric_name = "disk_used_percent"
  namespace   = "CWAgent"
  dimensions = {
    path   = "/"
    device = "nvme0n1p1"
  }
  threshold = 85  # Alert at 85% usage
}

resource "aws_cloudwatch_metric_alarm" "data_disk_usage" {
  alarm_name  = "devbox-data-disk-high"
  threshold   = 90  # Alert at 90% usage
}
```

### 4. Memory Usage Alarm
```hcl
resource "aws_cloudwatch_metric_alarm" "memory_usage" {
  alarm_name  = "devbox-memory-high"
  metric_name = "mem_used_percent"
  namespace   = "CWAgent"
  threshold   = 90
}
```

### 5. Dashboard
Create a CloudWatch dashboard with:
- CPU utilization over time
- Memory usage
- Disk I/O
- Network throughput
- Instance status

### 6. Log Aggregation (Optional)
- Ship /var/log/cloud-init-output.log to CloudWatch Logs
- Ship Docker logs
- Enable log insights queries

## Cost Estimate
- CloudWatch Agent: Free (included metrics)
- Custom metrics: ~$0.30/metric/month
- Alarms: ~$0.10/alarm/month
- Dashboard: $3/month
- **Total**: ~$5-10/month

## Acceptance Criteria
- [ ] CloudWatch agent installed and configured
- [ ] Instance status check alarm
- [ ] Root disk usage alarm (>85%)
- [ ] Data disk usage alarm (>90%)
- [ ] Memory usage alarm (>90%)
- [ ] SNS notifications for all alarms
- [ ] Basic CloudWatch dashboard
- [ ] IAM permissions for CloudWatch agent

## Labels
`enhancement`, `monitoring`, `observability`
