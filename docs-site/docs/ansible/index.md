---
sidebar_position: 1
---

# Ansible

> **Origin: Imladris additive** — These roles configure this specific workstation. They are not part of PAI upstream.

16 roles manage the complete OS-level state of imladris. Run via `ansible-playbook site.yml`.

## Playbooks

| Playbook | When | Purpose |
|----------|------|---------|
| `site.yml` | Full provision | All 16 roles, full workstation setup |
| `site-boot.yml` | Instance start | NVMe mount, Docker Compose up, services |
| `site-bake.yml` | AMI creation | Install packages, leave config for runtime |

[📁 View source → `ansible/`](https://github.com/sethdf/imladris/tree/main/ansible)

## Roles

### Core Services

| Role | What it configures | Source |
|------|--------------------|--------|
| **windmill** | Windmill Docker Compose stack, Postgres, worker config, env vars | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/windmill) |
| **docker** | Docker Engine + Docker Compose plugin, daemon config, log rotation | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/docker) |
| **tailscale** | Tailscale daemon, auth key, exit node config, subnet routes | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/tailscale) |
| **mcp-tools** | MCP server binaries, systemd services, config files for Claude Code | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/mcp-tools) |

### Runtime Environment

| Role | What it configures | Source |
|------|--------------------|--------|
| **bun** | Bun JavaScript runtime install + PATH | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/bun) |
| **nodejs** | Node.js LTS via nvm, npm global packages | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/nodejs) |
| **packages** | OS packages (git, jq, curl, awscli, etc.) | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/packages) |
| **repos** | Git repo clones (imladris, PAI) + symlinks | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/repos) |
| **nvme** | NVMe instance store format, mount at `/nvme`, temp dirs | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/nvme) |
| **steampipe** | Steampipe CLI + AWS plugin + FDW connection for compliance queries | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/steampipe) |

### Security & Identity

| Role | What it configures | Source |
|------|--------------------|--------|
| **bitwarden** | Bitwarden CLI (`bws`) for secrets, service account token | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/bitwarden) |
| **claude-code** | Claude Code CLI install, global settings, hooks | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/claude-code) |
| **ssm-disable** | Disables SSM agent after initial setup (Tailscale is the access layer) | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/ssm-disable) |
| **ai-failover** | AI failover daemon for Claude → Bedrock fallback | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/ai-failover) |

### Voice Interface

| Role | What it configures | Source |
|------|--------------------|--------|
| **voice-server** | ElevenLabs TTS server (Node.js systemd service) on port 8888 | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/voice-server) |
| **voice-client** | Voice client for triggering notifications from scripts | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/voice-client) |
| **mosh** | Mosh server for mobile/latent SSH connections | [📄](https://github.com/sethdf/imladris/tree/main/ansible/roles/mosh) |
