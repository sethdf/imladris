#!/bin/bash
# Show backup status

echo "=== Backup Status ==="
echo
echo "Local backups (LUKS encrypted, EBS snapshot-backed):"
ls -lh /data/backups/daily/ 2>/dev/null | tail -8 || echo "  No backups yet"
echo
echo "Latest backup:"
if [ -L /data/backups/latest ]; then
    du -sh /data/backups/latest
    ls -lh /data/backups/latest/ | tail -8
else
    echo "  No backup found"
fi
echo
echo "Next scheduled backup:"
systemctl list-timers backup-stateful.timer --no-pager | tail -2
echo
echo "LUKS volume snapshot status (AWS DLM):"
if command -v aws &>/dev/null; then
    VOLUME_ID=$(lsblk -o NAME,TYPE,SERIAL | grep disk | grep -v nvme0n1 | awk '{print $NF}' | sed 's/vol/vol-/' || echo "unknown")
    if [ "$VOLUME_ID" != "unknown" ]; then
        aws ec2 describe-snapshots --filters "Name=volume-id,Values=$VOLUME_ID" --query 'Snapshots[*].[StartTime,State,VolumeSize]' --output table 2>/dev/null | head -10 || echo "  Run with AWS credentials"
    fi
else
    echo "  aws CLI not configured"
fi
