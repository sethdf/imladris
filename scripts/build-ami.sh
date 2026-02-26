#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Imladris AMI Build Orchestrator
# =============================================================================
# Reads VPC/Subnet/KMS from CloudFormation stack outputs, runs Packer build,
# stores AMI ID in SSM, and optionally triggers a CF stack update.
#
# Usage:
#   ./scripts/build-ami.sh              # Build AMI only
#   ./scripts/build-ami.sh --deploy     # Build AMI + update CF stack
#
# Prerequisites:
#   - packer CLI installed
#   - AWS credentials with EC2/KMS/SSM permissions
#   - imladris CF stack deployed (for VPC/Subnet/KMS outputs)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
PACKER_DIR="$REPO_DIR/packer"

STACK_NAME="imladris"
REGION="us-east-1"
SSM_PARAM="/imladris/ami-id"
KEEP_AMIS=3
DEPLOY=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --deploy) DEPLOY=true ;;
    --stack=*) STACK_NAME="${arg#*=}" ;;
    --region=*) REGION="${arg#*=}" ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
  log "FATAL: $*"
  exit 1
}

# --- Step 1: Read CloudFormation stack outputs ---
log "Reading CloudFormation stack outputs from '$STACK_NAME'..."

get_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text 2>/dev/null
}

VPC_ID=$(get_output "VpcId")
SUBNET_ID=$(get_output "SubnetId")
KMS_KEY_ARN=$(get_output "KmsKeyArn")

# KmsKeyArn output is conditional (only present when CreateNewStorage=true).
# Fall back to the KMS alias if the output isn't available.
if [[ -z "$KMS_KEY_ARN" || "$KMS_KEY_ARN" == "None" ]]; then
  log "KmsKeyArn not in stack outputs (UseExistingStorage=true). Looking up via alias..."
  KMS_KEY_ARN=$(aws kms describe-key --key-id alias/workstation-ebs \
    --query "KeyMetadata.Arn" --output text --region "$REGION" 2>/dev/null)
fi

[[ -n "$VPC_ID" ]] || die "Could not read VpcId from stack '$STACK_NAME'"
[[ -n "$SUBNET_ID" ]] || die "Could not read SubnetId from stack '$STACK_NAME'"
[[ -n "$KMS_KEY_ARN" ]] || die "Could not determine KMS key ARN (not in stack outputs and alias/workstation-ebs not found)"

log "VPC:    $VPC_ID"
log "Subnet: $SUBNET_ID"
log "KMS:    $KMS_KEY_ARN"

# --- Step 2: Initialize and build ---
log "Initializing Packer plugins..."
cd "$REPO_DIR"
packer init "$PACKER_DIR/imladris.pkr.hcl"

log "Starting Packer build..."
BUILD_OUTPUT=$(packer build \
  -var "vpc_id=$VPC_ID" \
  -var "subnet_id=$SUBNET_ID" \
  -var "kms_key_id=$KMS_KEY_ARN" \
  -var "region=$REGION" \
  "$PACKER_DIR/imladris.pkr.hcl" 2>&1 | tee /dev/stderr)

# Extract AMI ID from Packer output
AMI_ID=$(echo "$BUILD_OUTPUT" | grep -oP 'ami-[0-9a-f]+' | tail -1)
[[ -n "$AMI_ID" ]] || die "Could not extract AMI ID from Packer output"

log "AMI built successfully: $AMI_ID"

# --- Step 3: Store AMI ID in SSM ---
log "Storing AMI ID in SSM parameter '$SSM_PARAM'..."
aws ssm put-parameter \
  --name "$SSM_PARAM" \
  --value "$AMI_ID" \
  --type String \
  --overwrite \
  --region "$REGION"

log "SSM parameter updated: $SSM_PARAM = $AMI_ID"

# --- Step 4: Clean up old AMIs (keep latest N) ---
log "Cleaning up old AMIs (keeping latest $KEEP_AMIS)..."

OLD_AMIS=$(aws ec2 describe-images \
  --owners self \
  --filters "Name=name,Values=imladris-*" "Name=tag:BuildType,Values=packer" \
  --query "sort_by(Images, &CreationDate)[:-${KEEP_AMIS}].ImageId" \
  --output text \
  --region "$REGION" 2>/dev/null || echo "")

if [[ -n "$OLD_AMIS" && "$OLD_AMIS" != "None" ]]; then
  for old_ami in $OLD_AMIS; do
    log "Deregistering old AMI: $old_ami"
    # Find and delete associated snapshots
    SNAPSHOTS=$(aws ec2 describe-images \
      --image-ids "$old_ami" \
      --query "Images[0].BlockDeviceMappings[*].Ebs.SnapshotId" \
      --output text \
      --region "$REGION" 2>/dev/null || echo "")

    aws ec2 deregister-image --image-id "$old_ami" --region "$REGION" 2>/dev/null || true

    for snap in $SNAPSHOTS; do
      [[ "$snap" == "None" || -z "$snap" ]] && continue
      log "  Deleting snapshot: $snap"
      aws ec2 delete-snapshot --snapshot-id "$snap" --region "$REGION" 2>/dev/null || true
    done
  done
  log "Cleanup complete."
else
  log "No old AMIs to clean up."
fi

# --- Step 5 (optional): Deploy via CloudFormation update ---
if [[ "$DEPLOY" == "true" ]]; then
  log "Triggering CloudFormation stack update..."

  # Get current parameters (preserve all existing values)
  CURRENT_PARAMS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Parameters" \
    --output json)

  # Update AmiId parameter to point to new SSM param
  aws cloudformation update-stack \
    --stack-name "$STACK_NAME" \
    --use-previous-template \
    --parameters "ParameterKey=AmiId,ParameterValue=$SSM_PARAM" \
    --capabilities CAPABILITY_NAMED_IAM \
    --region "$REGION" 2>/dev/null || {
      log "WARNING: Stack update failed or no changes detected."
    }

  log "Stack update initiated. Monitor with:"
  log "  aws cloudformation describe-stack-events --stack-name $STACK_NAME --region $REGION"
fi

log "=== Done ==="
log "AMI ID: $AMI_ID"
log "SSM Parameter: $SSM_PARAM"
