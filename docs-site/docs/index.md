---
id: index
sidebar_position: 1
slug: /
---

# Imladris

Personal cloud workstation on EC2 where Claude + PAI is the single interface for all DevOps work. Windmill orchestrates automation. Everything is code.

## What It Does

Imladris automates the full lifecycle of IT operations work:

1. **Triage** — emails, Slack, SDP tickets, and security alerts are ingested, classified by AI, and prioritized
2. **Investigate** — actionable items are automatically investigated using 45+ read-only tools spanning AWS, Azure, Cloudflare, SIEM, endpoint security, and monitoring
3. **Act** — high-confidence findings create SDP tasks, send Slack summaries, or escalate for human approval
4. **Report** — daily cost reports, compliance scans, investigation accuracy digests, and activity reports run on schedule

## Stack

| Layer | Technology |
|-------|-----------|
| **Compute** | EC2 m7gd.xlarge, encrypted EBS + 237GB NVMe |
| **Automation** | Windmill (self-hosted, Docker Compose) |
| **AI** | AWS Bedrock — Haiku (triage), Sonnet (investigation), Opus (complex) |
| **Network** | Tailscale — zero public inbound ports |
| **Infrastructure** | CloudFormation for all AWS resources |
| **Configuration** | Ansible for all OS-level state (16 roles) |
| **Monitoring** | SigNoz OTel collector + CloudWatch |

## Areas of Operation

- [**Infrastructure**](/cloudformation) — CloudFormation templates for EC2, IAM, KMS, cross-account roles, SigNoz, Securonix
- [**Configuration**](/ansible) — Ansible roles for all services (Windmill, Tailscale, Docker, MCP tools, voice, etc.)
- [**DevOps Automation**](/windmill/devops) — ~55 Windmill scripts for triage, investigation, SDP, Slack, monitoring
- [**Investigation Tools**](/windmill/investigate) — ~45 read-only scripts for AWS, Azure, Cloudflare, SIEM, Slack, Telegram
- [**Architecture Decisions**](/architecture) — 37 decisions covering infrastructure, security, and integration patterns
- [**PAI Configuration**](/pai-config) — Hooks, skills, and agents powering the AI layer
