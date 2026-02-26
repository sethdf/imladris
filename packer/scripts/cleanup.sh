#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# AMI Cleanup Script
# =============================================================================
# Runs after Packer bake to remove ephemeral data from the AMI.
# Ensures no stale code, SSH keys, or logs persist in the image.

echo "=== Starting AMI cleanup ==="

# Remove the repo clone (Decision: AMI must not contain stale code)
# Fresh clone happens at boot via the repos role
echo "Removing repo clone..."
rm -rf /home/ec2-user/repos/imladris

# Remove SSH authorized keys (Packer adds its own temp key)
echo "Cleaning SSH keys..."
rm -f /home/ec2-user/.ssh/authorized_keys
rm -f /root/.ssh/authorized_keys

# Clear package manager cache
echo "Cleaning package cache..."
sudo dnf clean all
sudo rm -rf /var/cache/dnf

# Clear pip cache
echo "Cleaning pip cache..."
rm -rf /home/ec2-user/.cache/pip
sudo rm -rf /root/.cache/pip

# Clear npm cache
echo "Cleaning npm cache..."
npm cache clean --force 2>/dev/null || true

# Clear bash history
echo "Cleaning shell history..."
rm -f /home/ec2-user/.bash_history
rm -f /root/.bash_history
unset HISTFILE

# Clear log files
echo "Cleaning logs..."
sudo rm -f /var/log/imladris-bootstrap.log
sudo truncate -s 0 /var/log/messages 2>/dev/null || true
sudo truncate -s 0 /var/log/secure 2>/dev/null || true
sudo truncate -s 0 /var/log/cloud-init.log 2>/dev/null || true
sudo truncate -s 0 /var/log/cloud-init-output.log 2>/dev/null || true

# Clear temp files
echo "Cleaning temp files..."
sudo rm -rf /tmp/*
sudo rm -rf /var/tmp/*

# Clear machine-id (regenerated on first boot for unique identity)
echo "Clearing machine-id..."
sudo truncate -s 0 /etc/machine-id

echo "=== AMI cleanup complete ==="
