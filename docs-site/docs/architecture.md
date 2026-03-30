---
sidebar_position: 5
---

# Architecture Decisions

> **Origin: Imladris additive** — These decisions govern this specific workstation's design. PAI has its own architectural principles (Algorithm, MEMORY, ISC methodology); these decisions govern how the imladris infrastructure layer is built on top of PAI.

37 architecture decisions define how imladris is built and how it evolves. Full source: [`ARCHITECTURE.md`](https://github.com/sethdf/imladris/blob/main/ARCHITECTURE.md)

> **See also:** [Cognitive Architecture](./cognitive-architecture) — the neuroscience and first-principles rationale behind why these decisions were made.

## Core Vision

A cloud-based, secure, **deterministic-first** workstation where Claude + PAI is the single interface for all DevOps work. One session. Zero authentication friction. Zero data loss. Zero context friction. Zero downtime.

> **Deterministic-First:** MCP tools as the default external access layer. CLI is the escape hatch, not the first reach. All calls logged.

## Intelligence Cycle

Every piece of external information follows the same four-stage cycle:

```
COLLECT ──→ CORRELATE ──→ SURFACE ──→ LEARN
  ↑                                     │
  └─────────────────────────────────────┘
  (learning improves what/when/how we collect)
```

- **COLLECT** — Windmill cron pulls (Steampipe, SDP, cost) + webhooks (SNS, Slack) + feeds
- **CORRELATE** — Same-entity, same-time, same-pattern, cross-domain via Steampipe SQL + triage agent
- **SURFACE** — Windmill → Claude investigation → Slack DM to Seth
- **LEARN** — MEMORY files, PRDs, accuracy digests, triage feedback

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | EC2 over container/serverless | Persistent NVMe for fast state; no cold start; full OS control |
| 2 | Windmill for automation | Self-hosted, credential store, visual UI, TypeScript workers, webhook support |
| 3 | Tailscale for all access | Zero public inbound; device-level auth; no VPN management |
| 4 | CloudFormation for all AWS | IaC-only; no manual console changes; reproducible |
| 5 | Ansible for all OS state | Idempotent; role-based; molecule-testable; GitOps |
| 6 | Bedrock over OpenAI | AWS-native; no egress token; IAM auth; multi-model (Haiku/Sonnet/Opus) |
| 7 | Steampipe for compliance | SQL over AWS APIs; cross-account; extensible to 600+ plugins |
| 26 | Cost report via Steampipe | Reuses existing Steampipe infra; no Cost Explorer API integration needed |
| 37 | Imladris is personal infrastructure | Every component exists solely to help Seth get work done. Never proposed to others as a remediation, recommendation, or solution |

## Security Posture

- No public inbound ports — Tailscale only
- EBS encrypted with customer-managed KMS key (automatic rotation)
- SSM disabled after initial setup (Tailscale replaces it)
- Cross-account roles are read-only by default; write roles scoped per account
- All Windmill credentials in Windmill variable store — no plaintext in code
- Slack messages route to Seth's DM only — never `#general` or other channels
