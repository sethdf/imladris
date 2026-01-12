output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.imladris.id
}

output "public_ip" {
  description = "Public IP address"
  value       = aws_instance.imladris.public_ip
}

output "tailscale_hostname" {
  description = "Tailscale hostname for SSH access"
  value       = var.tailscale_hostname
}

output "ssh_command" {
  description = "SSH command to connect (via Tailscale)"
  value       = "ssh ${var.tailscale_hostname}"
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
  description = "Instance type"
  value       = var.instance_type
}

output "volumes" {
  description = "EBS volumes"
  value = {
    root = "${var.volume_size}GB (OS, tools)"
    data = "${var.data_volume_size}GB (LUKS encrypted /data)"
  }
}
