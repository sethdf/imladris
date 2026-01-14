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
echo "=== Configuring imladris ==="
echo ""

# Clear old SSH host key (instance may have been recreated)
echo "Clearing old SSH host key for $IMLADRIS_HOST..."
ssh-keygen -f "$HOME/.ssh/known_hosts" -R "$IMLADRIS_HOST" 2>/dev/null || true

# Ensure AWS config exists but is empty (cloud-assume handles access)
echo "Configuring AWS CLI on $IMLADRIS_HOST..."
ssh -o StrictHostKeyChecking=accept-new "ubuntu@$IMLADRIS_HOST" bash -c "'
mkdir -p ~/.aws
echo \"# Cloud access managed by cloud-assume\" > ~/.aws/config
echo \"AWS config ready (use cloud-assume for access)\"
'"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Usage on imladris (cloud-assume controls access):"
echo ""
echo "  cloud-assume aws qat           # readonly access"
echo "  cloud-assume aws prod --admin  # admin access (logged)"
echo "  cloud-assume status            # show current access"
echo "  cloud-assume clear             # revoke access"
echo ""
echo "Available environments: qat, dev, prod, buxtonorgacct"
