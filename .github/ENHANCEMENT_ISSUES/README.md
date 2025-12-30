# Enhancement Issues

This directory contains templates for potential enhancements to the AWS DevBox project.

## Issues

| # | Enhancement | Priority | Effort |
|---|-------------|----------|--------|
| 001 | [Modularize Terraform](001-modularize-terraform.md) | Medium | High |
| 002 | [Add Terraform Testing](002-add-terraform-testing.md) | Medium | Medium |
| 003 | [Improve State Management](003-improve-state-management.md) | Low | Low |
| 004 | [Add CloudWatch Monitoring](004-add-cloudwatch-monitoring.md) | High | Medium |
| 005 | [Multi-Region Support](005-multi-region-support.md) | Low | High |

## Creating GitHub Issues

To create GitHub issues from these templates:

```bash
# Dry run (preview what will be created)
./.github/ENHANCEMENT_ISSUES/create-issues.sh --dry-run

# Create all issues
./.github/ENHANCEMENT_ISSUES/create-issues.sh
```

### Prerequisites
- [GitHub CLI](https://cli.github.com/) installed
- Authenticated: `gh auth login`

## Priority Guide

- **High**: Adds significant value with reasonable effort
- **Medium**: Nice to have, good for future improvements
- **Low**: Edge cases or advanced features

## Recommended Order

1. **004 - CloudWatch Monitoring** - Quick win, high value for observability
2. **001 - Modularize Terraform** - Foundation for other improvements
3. **002 - Add Testing** - Enables safer changes after modularization
4. **003 - State Management** - Evaluate based on team needs
5. **005 - Multi-Region** - Advanced feature, implement as needed
