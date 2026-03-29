---
sidebar_position: 1
---

# CloudFormation

All AWS infrastructure is defined as CloudFormation. No manual console changes.

## Templates

### imladris-stack.yaml

**What it does:** Provisions the core imladris EC2 workstation — instance, security group, IAM role, KMS encryption key, and all supporting resources.

**Key resources:**
- EC2 `m7gd.xlarge` with encrypted EBS root volume (customer-managed KMS key)
- IAM instance role with Bedrock, SSM, CloudTrail, S3 read permissions
- Security group locked to Tailscale traffic only (no public inbound)
- KMS key for EBS encryption with automatic key rotation

[📄 View source → `cloudformation/imladris-stack.yaml`](https://github.com/sethdf/imladris/blob/main/cloudformation/imladris-stack.yaml)

---

### cross-account-stackset.yaml

**What it does:** Deploys IAM roles into all 16 managed AWS accounts via StackSets, giving imladris read-only and read-write cross-account access.

**Key resources:**
- `ImladrisReadOnlyRole` — deployed to all 16 accounts; assumed by imladris EC2 role for investigation tools
- `ImladrisReadWriteRole` — deployed to designated accounts; for remediation actions
- Trust policy restricts to imladris EC2 instance role ARN only

[📄 View source → `cloudformation/cross-account-stackset.yaml`](https://github.com/sethdf/imladris/blob/main/cloudformation/cross-account-stackset.yaml)

---

### signoz-otel-collector.yaml

**What it does:** Deploys SigNoz OTel collector as a sidecar on imladris for collecting metrics, logs, and traces and shipping to SigNoz Cloud.

**Key resources:**
- ECS task definition for the OTel collector container
- IAM task role for CloudWatch and SSM access
- Environment variable injection for SigNoz API key

[📄 View source → `cloudformation/signoz-otel-collector.yaml`](https://github.com/sethdf/imladris/blob/main/cloudformation/signoz-otel-collector.yaml)

---

### ramp-securonix/template.yaml

**What it does:** Deploys an AWS Lambda function that exports RAMP audit logs to Securonix SIEM via HTTP Event Receiver ingestion.

**Key resources:**
- Lambda function (Python 3.12) — polls RAMP API, batches events, POSTs to Securonix HEC endpoint
- EventBridge rule for scheduled execution
- Secrets Manager secret for RAMP API credentials and Securonix token
- IAM execution role

[📄 View source → `cloudformation/ramp-securonix/template.yaml`](https://github.com/sethdf/imladris/blob/main/cloudformation/ramp-securonix/template.yaml)
[📄 View Lambda source → `cloudformation/ramp-securonix/lambda_function.py`](https://github.com/sethdf/imladris/blob/main/cloudformation/ramp-securonix/lambda_function.py)
