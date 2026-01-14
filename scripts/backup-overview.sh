#!/bin/bash
# Overview of complete backup strategy

cat <<'EOF'
=== Imladris Backup Strategy ===

📦 Layer 1: EBS Snapshots (Whole LUKS Volume)
   • Automatic via AWS DLM (Data Lifecycle Manager)
   • Captures entire encrypted block device (100GB)
   • Hourly snapshots, keeps 24 hours
   • Incremental (only changed blocks cost money)
   • Volume: vol-05d57d9141606e8a8 (hall-of-fire)
   • Status: aws ec2 describe-snapshots --filters "Name=volume-id,Values=vol-05d57d9141606e8a8"
   
📁 Layer 2: File-Level Sync (Selective Backup)
   • Hourly rsync to /data/backups/
   • Keeps 7 days of daily backups
   • Efficient: only changed files
   • Paths: ~/.claude, ~/repos, ~/bin, ~/.config, ~/.ssh
   • Status: backup-status

☁️  Layer 3: Offsite S3 Sync (Optional)
   • Sync /data/backups/ to S3
   • Cross-region/-account protection
   • Intelligent tiering for cost savings
   • Setup: export BACKUP_S3_BUCKET=s3://your-bucket
   • Run: backup-to-s3

🔐 Encryption:
   • EBS snapshots: encrypted at rest (LUKS inside snapshot)
   • S3: Server-side encryption (SSE-S3/KMS)
   • LUKS passphrase in Bitwarden Secrets Manager

Commands:
   backup-stateful      Run backup now
   backup-status        Show backup status
   backup-to-s3         Sync to S3 (after BACKUP_S3_BUCKET set)
   
EOF
