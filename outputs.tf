output "instance_id" {
  description = "EC2 instance ID (empty for Fleet mode - instance IDs are dynamic)"
  value       = var.use_fleet ? "managed-by-fleet" : aws_instance.imladris[0].id
}

output "fleet_id" {
  description = "EC2 Fleet ID (if using Fleet mode)"
  value       = var.use_fleet ? aws_ec2_fleet.imladris[0].id : ""
}

output "tailscale_hostname" {
  description = "Tailscale hostname for SSH access"
  value       = var.tailscale_hostname
}

output "ssh_command" {
  description = "SSH command to connect (via Tailscale)"
  value       = "ssh ${var.tailscale_hostname}"
}

output "mosh_command" {
  description = "Mosh command to connect (via Tailscale)"
  value       = "mosh ${var.tailscale_hostname}"
}

output "vscode_remote" {
  description = "VS Code Remote SSH config entry"
  value       = <<-EOT
    Host ${var.tailscale_hostname}
        HostName ${var.tailscale_hostname}
  EOT
}

output "ami_id" {
  description = "Ubuntu AMI used"
  value       = data.aws_ami.ubuntu.id
}

output "ami_name" {
  description = "Ubuntu AMI name"
  value       = data.aws_ami.ubuntu.name
}

output "instance_type" {
  description = "Instance type (for non-Fleet mode) or Fleet types"
  value       = var.use_fleet ? join(", ", var.fleet_instance_types) : var.instance_type
}

output "fleet_enabled" {
  description = "Whether EC2 Fleet is enabled for multi-instance-type availability"
  value       = var.use_fleet
}

output "spot_enabled" {
  description = "Whether spot pricing is enabled"
  value       = var.use_spot
}

output "pricing_estimate" {
  description = "Estimated hourly cost"
  value       = var.use_spot ? "~$0.03-0.10/hr (spot, varies by type)" : "~$0.08-0.20/hr (on-demand, varies by type)"
}

output "volumes" {
  description = "EBS volumes"
  value = {
    root = "${var.volume_size}GB (OS, tools)"
    data = "${var.data_volume_size}GB (LUKS encrypted /data)"
  }
}
