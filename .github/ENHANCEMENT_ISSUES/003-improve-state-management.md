# Improve Terraform State Management

## Summary
Evaluate alternatives to git-crypt encrypted local state for more robust state management, particularly for team scenarios or disaster recovery.

## Current State
- Terraform state is stored locally and committed to git
- State is encrypted using git-crypt
- Works well for single-user scenario but has limitations

## Current Approach - Pros
- Simple setup, no additional infrastructure
- State versioned with code
- Works offline
- No recurring costs

## Current Approach - Cons
- State locking not available (risk of concurrent modifications)
- Large state files bloat git history
- Recovery depends on git-crypt key backup
- Not suitable for team collaboration

## Proposed Alternatives

### Option A: S3 Backend with DynamoDB Locking
```hcl
terraform {
  backend "s3" {
    bucket         = "devbox-terraform-state"
    key            = "aws-devbox/terraform.tfstate"
    region         = "us-west-2"
    encrypt        = true
    dynamodb_table = "terraform-state-lock"
  }
}
```

**Pros**: Native state locking, versioning, encryption at rest
**Cons**: Requires bootstrap infrastructure, small ongoing cost (~$1/month)

### Option B: Terraform Cloud (Free Tier)
```hcl
terraform {
  cloud {
    organization = "your-org"
    workspaces {
      name = "aws-devbox"
    }
  }
}
```

**Pros**: State locking, UI, run history, free for individuals
**Cons**: External dependency, requires account

### Option C: Keep Current + Add Safeguards
- Add pre-commit hook to warn about uncommitted state
- Document recovery procedures
- Automate git-crypt key backup to Bitwarden

## Recommendation
For single-user: **Option C** (current + safeguards)
For team/production: **Option A** (S3 backend)

## Acceptance Criteria
- [ ] Document trade-offs in README
- [ ] If S3 backend: Create bootstrap script for state infrastructure
- [ ] If keeping local: Add pre-commit safeguards
- [ ] Document disaster recovery procedure
- [ ] Backup git-crypt key to Bitwarden automatically

## Labels
`enhancement`, `terraform`, `documentation`
