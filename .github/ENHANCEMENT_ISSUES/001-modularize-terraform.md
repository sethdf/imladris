# Modularize Terraform Configuration

## Summary
Split the monolithic `main.tf` (~1,600 lines) into logical Terraform modules for better maintainability, reusability, and testing.

## Current State
All infrastructure is defined in a single `main.tf` file, making it difficult to:
- Test individual components
- Reuse components across projects
- Navigate and understand the codebase
- Make isolated changes safely

## Proposed Modules

### 1. `modules/network/`
- VPC configuration
- Subnet definitions
- Internet gateway
- Security groups

### 2. `modules/compute/`
- EC2 instance
- EBS volumes (root + data)
- Instance profile/IAM role
- User data template

### 3. `modules/backup/`
- DLM lifecycle policy
- Snapshot scheduling
- Retention rules

### 4. `modules/scheduling/`
- EventBridge scheduler
- Start/stop schedules
- Scheduler IAM role

### 5. `modules/spot-management/`
- Lambda function
- EventBridge rule for spot interruptions
- SNS topic for notifications
- Lambda IAM role

## Acceptance Criteria
- [ ] Each module is self-contained with its own `variables.tf`, `outputs.tf`, `main.tf`
- [ ] Root module composes all child modules
- [ ] All existing functionality preserved
- [ ] Variables documented with descriptions and validation
- [ ] `terraform plan` shows no changes after refactor

## Labels
`enhancement`, `terraform`, `refactoring`
