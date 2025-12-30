# Integration Tests

Integration tests deploy real AWS infrastructure to verify the devbox works correctly.

## Prerequisites

1. Go 1.21+
2. AWS credentials with sufficient permissions
3. A test.tfvars file (see below)

## Setup

```bash
# Install Terratest
cd tests/integration
go mod init integration-tests
go get github.com/gruntwork-io/terratest/modules/terraform
go get github.com/stretchr/testify/assert
```

## Running Tests

```bash
# Set AWS credentials
export AWS_PROFILE=your-profile

# Run integration tests (WARNING: creates real resources, costs money)
go test -v -timeout 30m
```

## Test Coverage

| Test | Verifies |
|------|----------|
| TestVpcCreation | VPC and subnets created correctly |
| TestSecurityGroup | No public ingress, egress allowed |
| TestSpotConfig | Spot instance configuration valid |
| TestEbsVolumes | Root and data volumes sized correctly |

## Cost Warning

Integration tests create real AWS resources. Expected cost per run:
- ~$0.05-0.10 for EC2 spot (if it runs briefly)
- ~$0.01 for EBS snapshots
- Free tier: VPC, security groups

Tests automatically destroy resources after completion.

## test.tfvars Example

```hcl
# Minimal config for testing
bitwarden_email    = "test@example.com"
github_username    = "testuser"
use_spot           = false  # On-demand for reliable testing
enable_schedule    = false  # No schedules during test
notification_emails = []
```
