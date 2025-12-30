# Add Multi-Region Support and Failover

## Summary
Enable deployment to multiple AWS regions for lower latency, spot capacity resilience, and disaster recovery options.

## Current State
- Hardcoded to single region (us-west-2)
- AMI lookup is region-specific
- No failover mechanism for spot capacity exhaustion

## Use Cases

### 1. Latency Optimization
Deploy to region closest to current location for best SSH/Tailscale performance.

### 2. Spot Capacity Resilience
If one region has no spot capacity, quickly switch to another region.

### 3. Disaster Recovery
Ability to restore from snapshots in a different region.

## Proposed Implementation

### Phase 1: Region Variable
```hcl
variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-west-2"

  validation {
    condition = contains([
      "us-west-2", "us-east-1", "us-east-2",
      "eu-west-1", "eu-central-1"
    ], var.aws_region)
    error_message = "Unsupported region."
  }
}
```

### Phase 2: Dynamic AMI Lookup
```hcl
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]  # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-*"]
  }

  filter {
    name   = "architecture"
    values = [var.architecture]
  }
}
```

### Phase 3: Cross-Region Snapshot Copy
```hcl
variable "backup_region" {
  description = "Secondary region for snapshot copies"
  type        = string
  default     = ""  # Empty = no cross-region backup
}

resource "aws_dlm_lifecycle_policy" "cross_region" {
  count = var.backup_region != "" ? 1 : 0

  policy_details {
    action {
      name = "Cross-region copy"
      cross_region_copy {
        target    = var.backup_region
        retain_rule {
          interval = 7
        }
      }
    }
  }
}
```

### Phase 4: Workspace-Based Multi-Region
```bash
# Deploy to different regions using workspaces
terraform workspace new us-east-1
terraform apply -var="aws_region=us-east-1"

terraform workspace new eu-west-1
terraform apply -var="aws_region=eu-west-1"
```

### Phase 5: Region Failover Script
```bash
#!/bin/bash
# Quick failover when spot capacity unavailable
REGIONS=("us-west-2" "us-east-1" "us-east-2")

for region in "${REGIONS[@]}"; do
  if check_spot_capacity "$region"; then
    terraform apply -var="aws_region=$region"
    break
  fi
done
```

## Considerations
- Tailscale device names should include region
- Different regions have different spot pricing
- Cross-region data transfer has costs
- Some regions lack Graviton instances

## Acceptance Criteria
- [ ] Region configurable via variable
- [ ] Dynamic AMI lookup per region
- [ ] Documentation for multi-region deployment
- [ ] Optional cross-region snapshot copy
- [ ] Region selection guidance in README

## Labels
`enhancement`, `infrastructure`, `resilience`
