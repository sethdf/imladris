#!/bin/bash
# Setup cross-account IAM roles for imladris access
# Run this locally where you have AWS SSO access
#
# This script:
# 1. Creates ImladrisReadOnly and ImladrisAdmin roles in each target account
# 2. Clears old SSH host keys for imladris (handles instance recreation)
# 3. Creates ~/.aws/config on imladris with all the profiles
#
# Prerequisites:
# - AWS SSO authenticated for qat, dev, prod, buxtonorgacct profiles
# - imladris instance running and accessible via Tailscale
set -euo pipefail

IMLADRIS_ROLE_ARN="arn:aws:iam::IMLADRIS_ACCOUNT_ID:role/imladris-instance-role"
IMLADRIS_HOST="imladris"

# Trust policy allowing imladris to assume roles
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "$IMLADRIS_ROLE_ARN"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
)

create_role() {
    local profile="$1"
    local role_name="$2"
    local policy_arn="$3"

    echo "=== Creating $role_name in profile: $profile ==="

    # Check if role exists
    if aws --profile "$profile" iam get-role --role-name "$role_name" &>/dev/null; then
        echo "  Role exists, updating trust policy..."
        aws --profile "$profile" iam update-assume-role-policy \
            --role-name "$role_name" \
            --policy-document "$TRUST_POLICY"
    else
        echo "  Creating role..."
        aws --profile "$profile" iam create-role \
            --role-name "$role_name" \
            --assume-role-policy-document "$TRUST_POLICY" \
            --description "Cross-account access from imladris devbox"

        echo "  Attaching policy: $policy_arn"
        aws --profile "$profile" iam attach-role-policy \
            --role-name "$role_name" \
            --policy-arn "$policy_arn"
    fi

    echo "  Done: arn:aws:iam::$(aws --profile "$profile" sts get-caller-identity --query Account --output text):role/$role_name"
    echo ""
}

echo "Creating imladris cross-account roles..."
echo ""

# QAT - Both readonly and admin
create_role "qat" "ImladrisReadOnly" "arn:aws:iam::aws:policy/ReadOnlyAccess"
create_role "qat" "ImladrisAdmin" "arn:aws:iam::aws:policy/AdministratorAccess"

# Dev - Both readonly and admin
create_role "dev" "ImladrisReadOnly" "arn:aws:iam::aws:policy/ReadOnlyAccess"
create_role "dev" "ImladrisAdmin" "arn:aws:iam::aws:policy/AdministratorAccess"

# Prod - Both readonly and admin
create_role "prod" "ImladrisReadOnly" "arn:aws:iam::aws:policy/ReadOnlyAccess"
create_role "prod" "ImladrisAdmin" "arn:aws:iam::aws:policy/AdministratorAccess"

# Buxton Org Account - Both readonly and admin
create_role "buxtonorgacct" "ImladrisReadOnly" "arn:aws:iam::aws:policy/ReadOnlyAccess"
create_role "buxtonorgacct" "ImladrisAdmin" "arn:aws:iam::aws:policy/AdministratorAccess"

echo "=== All roles created ==="
echo ""

# AWS config content for imladris
AWS_CONFIG=$(cat <<'AWSCONFIG'
# Cross-account profiles for imladris
# Default profiles use ReadOnly (safe for everyday use)
# Use *-admin profiles explicitly when needed

[profile qat]
role_arn = arn:aws:iam::QAT_ACCOUNT_ID:role/ImladrisReadOnly
credential_source = Ec2InstanceMetadata
region = us-east-1

[profile dev]
role_arn = arn:aws:iam::DEV_ACCOUNT_ID:role/ImladrisReadOnly
credential_source = Ec2InstanceMetadata
region = us-east-1

[profile prod]
role_arn = arn:aws:iam::PROD_ACCOUNT_ID:role/ImladrisReadOnly
credential_source = Ec2InstanceMetadata
region = us-east-1

[profile buxtonorgacct]
role_arn = arn:aws:iam::BUXTONORGACCT_ACCOUNT_ID:role/ImladrisReadOnly
credential_source = Ec2InstanceMetadata
region = us-east-1

[profile qat-admin]
role_arn = arn:aws:iam::QAT_ACCOUNT_ID:role/ImladrisAdmin
credential_source = Ec2InstanceMetadata
region = us-east-1

[profile dev-admin]
role_arn = arn:aws:iam::DEV_ACCOUNT_ID:role/ImladrisAdmin
credential_source = Ec2InstanceMetadata
region = us-east-1

[profile prod-admin]
role_arn = arn:aws:iam::PROD_ACCOUNT_ID:role/ImladrisAdmin
credential_source = Ec2InstanceMetadata
region = us-east-1

[profile buxtonorgacct-admin]
role_arn = arn:aws:iam::BUXTONORGACCT_ACCOUNT_ID:role/ImladrisAdmin
credential_source = Ec2InstanceMetadata
region = us-east-1
AWSCONFIG
)

echo "=== Configuring imladris ==="
echo ""

# Clear old SSH host key (instance may have been recreated)
echo "Clearing old SSH host key for $IMLADRIS_HOST..."
ssh-keygen -f "$HOME/.ssh/known_hosts" -R "$IMLADRIS_HOST" 2>/dev/null || true

# Create AWS config on imladris
echo "Creating ~/.aws/config on $IMLADRIS_HOST..."
ssh -o StrictHostKeyChecking=accept-new "ubuntu@$IMLADRIS_HOST" bash -c "'
mkdir -p ~/.aws
cat > ~/.aws/config << \"EOF\"
$AWS_CONFIG
EOF
echo \"AWS config created successfully\"
'"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Available profiles on imladris:"
echo "  ReadOnly (default): qat, dev, prod, buxtonorgacct"
echo "  Admin (explicit):   qat-admin, dev-admin, prod-admin, buxtonorgacct-admin"
echo ""
echo "Usage examples:"
echo "  aws --profile qat s3 ls"
echo "  aws --profile dev-admin ec2 describe-instances"
echo "  AWS_PROFILE=prod aws lambda list-functions"
