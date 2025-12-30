# Add Terraform Testing and Validation

## Summary
Implement automated testing and validation for Terraform configurations to catch issues before deployment.

## Current State
No automated testing exists for the Terraform configuration. Changes are validated only through manual `terraform plan` review.

## Proposed Implementation

### 1. Static Analysis
- **tflint**: Terraform linter for best practices and AWS-specific rules
- **tfsec**: Security scanner for Terraform
- **checkov**: Policy-as-code for infrastructure compliance

### 2. Format and Validation
- `terraform fmt -check` for consistent formatting
- `terraform validate` for syntax validation
- Pre-commit hooks for automated checks

### 3. Unit Testing with Terratest
```go
// Example test structure
func TestVpcCreation(t *testing.T) {
    // Validate VPC CIDR, subnet configuration
}

func TestSecurityGroupRules(t *testing.T) {
    // Ensure no unintended ingress rules
}
```

### 4. Integration Tests
- Ephemeral test environment deployment
- Validate Tailscale connectivity
- Verify spot instance behavior
- Cleanup after tests

### 5. CI/CD Integration
```yaml
# .github/workflows/terraform-ci.yml
- terraform fmt -check
- terraform validate
- tflint
- tfsec
- terratest (on PR to main)
```

## Acceptance Criteria
- [ ] Pre-commit hooks configured for fmt/validate
- [ ] tflint and tfsec configured with custom rules
- [ ] At least 3 Terratest unit tests
- [ ] GitHub Actions workflow for CI
- [ ] Documentation for running tests locally

## Labels
`enhancement`, `testing`, `ci-cd`
