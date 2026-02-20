# Imladris

Cloud workstation on EC2 where Claude+PAI is the single interface for all DevOps work.

## Architecture

- **Single EC2 instance** (t3.xlarge) with encrypted EBS (customer-managed KMS key)
- **Windmill** (self-hosted, Docker Compose) for automation, credentials, and workflows
- **Tailscale** for all network access (zero public inbound ports)
- **CloudFormation** for all infrastructure-as-code

Full architecture spec: see `cloud-workstation-vision.md` in PAI memory.

## Structure

```
cloudformation/
  imladris-stack.yaml          EC2, security group, IAM role, KMS key
  cross-account-stackset.yaml  ReadOnly + ReadWrite roles for 10+ accounts
bootstrap.sh                   Instance init: deps, symlinks, services
docker-compose.yml             Windmill + supporting services
tailscale/                     Tailscale setup and ACL config
```

## File Layout on the Workstation

Repos ARE production. No copy/deploy step.

```
~/repos/
  PAI/          -> symlinked from ~/.claude/skills/, ~/.claude/agents/
  imladris/     -> this repo (bootstrap, infra, services)
  dotfiles/     -> symlinked from ~/.bashrc, ~/.tmux.conf, etc.

~/.claude/
  skills/       -> SYMLINK to ~/repos/PAI/skills/
  agents/       -> SYMLINK to ~/repos/PAI/agents/
  MEMORY/       -> REAL DIR (runtime state, never in git)
  settings.json -> REAL FILE (local config)
  .env          -> REAL FILE (secrets, never in git)
```

## Quick Start

```bash
# On a fresh EC2 instance:
git clone https://github.com/sethdf/imladris.git ~/repos/imladris
cd ~/repos/imladris
./bootstrap.sh
```

## Security Posture

7 layers: CMK encryption, MFA-locked KMS, YubiKey root, deleted OrgAccessRole, SCP identity protection, CloudTrail detection, Tailscale-only network.

## Previous Version

The v1 codebase (Terraform/Nix-based) is preserved at tag `v1-archive`.
