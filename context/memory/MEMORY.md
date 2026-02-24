# Session Memory

## Seth's Context
- DevOps role — AWS research/correlation, ticket management, infrastructure building
- Uses ManageEngine ServiceDesk Plus Cloud for tickets
- Building a cloud-based, secure, deterministic-first workstation on EC2
- Claude+PAI is the single interface — one session, all work
- **#1 priority: zero context loss**

## Architecture Files
- `cloud-workstation-vision.md` — Full architecture spec, 34 design decisions, 6-phase roadmap, UX friction audit
- `devops-architecture.md` — MCP, Steampipe, CLI patterns, Anthropic's tool philosophy

## Key Decisions (40 total, 2026-02-18/22)

### Foundation (Decisions 1-5)
1. **Deterministic-First** — evolves CLI-First. MCP default, CLI escape hatch, all logged
2. **MCP as default external access** — hook logging (mcp__*) provides determinism
3. **Windmill as automation/credential layer** — self-hosted on EC2, scripts auto-expose as MCP tools
4. **SDP via Windmill scripts** — no dedicated SDP MCP server. Credentials in vault, auto-MCP.
5. **CLI as escape hatch** — aws CLI, steampipe CLI, mcp-tools for ~10% of work MCP doesn't cover

### Architecture (Decisions 6-10)
6. **Single session, multiple workstreams** — PRDs replace tmux panes for context
7. **current-work.json as state bridge** — survives sessions, enables instant recovery
8. **Two-layer persistence** — DLM hourly EBS snapshots (machine) + hook-driven state files (context)
9. **tmux demoted** — session persistence layer + background daemons, not a workspace manager
10. **MCP adds value beyond transport** — schema discovery, composite tools, guardrails

### Integrations (Decisions 11-16)
11. **OpenClaw dropped** — 60+ CVEs for a webhook bridge when Windmill already does it
12. **Windmill is messaging gateway** — Slack bot → `claude -p` + PAI. One brain, two doors.
13. **Bitwarden Secrets = source of truth** — Windmill vault is operational cache (synced)
14. **Transport ≠ service auth** — MCP auth is transport. Service auth follows credential hierarchy.
15. **No third-party MCP with stored creds** — build Windmill scripts instead. Two categories only.
16. **No long-lived AWS credentials** — EC2 IAM role for everything. Zero stored access keys.

### Multi-Account & Infrastructure (Decisions 17-21)
17. **10+ accounts via AssumeRole** — two cross-account roles per account, deployed via StackSet
18. **Windmill: Docker Compose on same EC2** — t3.xlarge (4 vCPU, 16GB), captured by EBS snapshots
19. **Implicit workstream switching** — PAI detects from natural language via CONTEXT RECOVERY
20. **Bitwarden sync via cron** — one bootstrap secret, daily `bws` CLI sync
21. **Automatic cold-start dashboard** — SessionStart hook reads current-work.json + Windmill API

### Session Management & Resilience (Decisions 22-24)
22. **Three-layer session bg/fg** — background agents (exists), `claude --resume` + PRD (exists), `pai work/shelve/jobs` (to build)
23. **Claude runs inside tmux** — SSH disconnect ≠ session lost. Zero-downtime depends on this.
24. **PRD continuous sync via hook + prompt** — PrdSync.hook.ts (deterministic) + Algorithm prompt (backup). Session death loses nothing. /clear is safe. Recovery in ~10s.

### Triage, Reporting & Guardrails (Decisions 25-29, 37)
25. **All inputs → Windmill auto-triage** — Slack, SDP, AWS alerts, GitHub → triage script → claude -p with context bundle → NOTIFY/QUEUE/AUTO
26. **Automatic daily/weekly activity reports** — Windmill cron, manager-friendly, no ISC jargon
27. **ReadWrite escalation** — PAI auto-escalates + SecurityValidator hook confirms all writes
28. **Messaging destructive ops** — Windmill approval flows, Seth approves from Slack or Windmill UI
29. **Windmill authoring via `wmill` CLI** — browser only for one-time OAuth redirects
30. **EBS encryption with customer-managed CMK** — all volumes/snapshots encrypted, key policy you control, CloudTrail logs all usage. Zero friction. LUKS declined (breaks auto-recovery).
31. **YubiKey FIDO2 on root** — hardware MFA on member account root. Two keys (primary + backup). Seals the ultimate override path.
32. **Delete OrganizationAccountAccessRole** — removes management account's IAM path into workstation. Combined with YubiKey root: no external actor can read data.
33. **Tailscale-only network access** — zero public inbound ports. SSH, Windmill UI, everything via Tailscale mesh VPN. Zero attack surface.
34. **Repos ARE production via symlinks** — all code in `~/repos/`, Claude Code paths (`~/.claude/skills/`, `~/.claude/agents/`) are symlinks into repos. Edit = live immediately. Runtime state (MEMORY, PRDs, logs) stays in `~/.claude/` as real dirs, never in git. Secrets stay local.
35. **CloudFormation for all IaC** — single tool, StackSets for cross-account, no state file. Templates in `~/repos/imladris/cloudformation/`.
36. **Code Factory via thin orchestrator** — `factory.ts` reads PRD, partitions ISC, spawns parallel Claude agents in worktrees (`claude -p --worktree`), optional review agent, merge + PR via `gh`. PAI does thinking, factory is pure plumbing. Disposable if PAI ships native.
37. **Domain tagging: work vs personal** — every workstream tagged `work` (default) or `personal`. Inferred from source mapping + content analysis, zero manual friction. Flows through: PRD frontmatter, current-work.json, triage, reports (manager reports exclude personal), guardrails (personal has no work AWS access), KB (S3 prefix partitioning), agent inheritance, dashboard grouping.

### Deployment & Bootstrap (Decisions 38-42)
38. **Amazon Linux 2023 ARM** — Graviton-native, SSM pre-installed, `dnf` compatible, AMI via SSM parameter lookup.
39. **UserData automated deploy** — CF installs Ansible, runs playbook. Instance comes up fully provisioned. Terminate and redeploy on failure.
40. **SSM Parameter Store with CMK** — bws token as SecureString encrypted with workstation CMK. Same trust model as EBS.
41. **Ansible as configuration management** — host state always known. Every package, config, service declared in Ansible roles. `--check --diff` detects drift. CloudFormation owns AWS resources, Ansible owns OS state. Applied from Aurora over Tailscale SSH.
42. **Mosh for connection resilience** — UDP-based shell survives network switches and high latency. Combined with tmux: network drops are invisible.

## Key Patterns
- **Intelligence Cycle:** COLLECT→CORRELATE→SURFACE→LEARN — PAI's existing pattern given infrastructure (Steampipe, Windmill, webhooks, cron). 5 gaps identified for Phase 6.
- **Two-layer everything:** Hook-driven (deterministic) + prompt-driven (AI behavior) for resilience. Neither depends on the other.
- **PRD is the saved game state** — working memory dies with session, PRD survives on disk, ISC rebuilt from PRD via CONTEXT RECOVERY.
- **Existing effort levels handle emergencies** — no special emergency mode needed. Incidents need MORE structure, not less.
- **Prompt-driven persistence is fragile** — always pair with deterministic hooks. Hooks survive prompt changes.

## Friction Audit Summary
- 18 friction findings (F1-F18), 4 speed (S1-S4), 3 guardrail (G1-G3)
- RESOLVED: F1, F4, F5 (invalid), F11, G1, G2
- Key unresolved: F13 (Windmill SPOF), F2 (state only during Algorithm), F6 (opaque errors), F7 (credential recovery UX)

## Roadmap
6 phases: Foundation → Service Integrations → Context Persistence → Workstream Management → Automation/Triage/Reports → Intelligence Cycle Expansion

## Status: PHASE 1 IN PROGRESS — Ansible playbook built, ready to deploy
42 decisions locked. All 13 questions answered. Roadmap complete. Ansible replaces bootstrap.sh.
Account: 767448074758 | Stack: deleted (awaiting redeploy with Ansible)
