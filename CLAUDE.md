# AWS DevBox - AI Assistant Guide

Terraform-managed AWS development workstation using spot instances with Tailscale VPN access.

## Project Overview

**Purpose:** Cost-optimized cloud dev environment (~$18/month vs $150 on-demand)
**Instance:** EC2 m7a.xlarge (4 vCPU, 16GB RAM) on spot pricing
**Access:** Tailscale mesh VPN (zero public ports)
**Storage:** LUKS-encrypted EBS volume with daily snapshots

## Key Files

| File | Purpose |
|------|---------|
| `main.tf` | Core infrastructure (VPC, EC2, EBS, IAM, Lambda) |
| `variables.tf` | Input variables with defaults |
| `outputs.tf` | Terraform outputs |
| `terraform.tfvars` | Environment config (git-crypt encrypted) |
| `Makefile` | Automation targets |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/user-data-nix.sh` | Instance bootstrap (Nix + home-manager) |
| `scripts/spot-interruption-handler.sh` | Handles spot termination events |
| `scripts/spot_restart.py` | Lambda: auto-restart on spot interruption |
| `scripts/imladris-*.sh` | Instance initialization and restore |
| `scripts/session-sync.sh` | Encrypted session state sync to S3 |
| `scripts/auth-keeper.sh` | Credential/secret management |

## Common Commands

```bash
make plan          # Preview changes
make apply         # Deploy infrastructure
make destroy       # Tear down (keeps EBS volume)
make cost          # Show AWS billing
make validate      # Lint Terraform + shell
```

## Architecture

```
┌─────────────────────────────────────────┐
│  VPC (10.0.0.0/16)                      │
│  ┌───────────────────────────────────┐  │
│  │  Public Subnet                    │  │
│  │  ┌─────────────┐  ┌────────────┐  │  │
│  │  │ EC2 Spot    │──│ EBS Data   │  │  │
│  │  │ (imladris)  │  │ (hall-of-  │  │  │
│  │  │             │  │  fire)     │  │  │
│  │  └─────────────┘  └────────────┘  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
         │
         │ Tailscale VPN (no public SSH)
         │
    ┌────┴────┐
    │ Client  │
    └─────────┘
```

## Security Notes

- **Secrets:** `terraform.tfvars` is git-crypt encrypted
- **Access:** IMDSv2 enforced, no public IP
- **Storage:** LUKS encryption on data volume
- **Keys:** Backed up via Bitwarden Secrets Manager

## Important Conventions

- Instance hostname: `imladris`
- Data volume name: `hall-of-fire`
- Default region: `us-east-1`
- Declarative config via Nix (not imperative apt)

## Testing

```bash
cd tests/unit && python -m pytest test_spot_restart.py
```

## Related Docs

- `README.md` - User-facing documentation
- `DEVBOX.md` - Architecture deep-dive
- `LEARNINGS.md` - Implementation decisions
