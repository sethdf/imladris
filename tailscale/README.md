# Tailscale Setup

Decision #33: All workstation access via Tailscale mesh VPN. Zero public inbound ports.

## Install

```bash
# Amazon Linux 2023 / Fedora
sudo dnf install -y tailscale
sudo systemctl enable --now tailscaled
```

## Enroll

```bash
# Interactive (first time)
sudo tailscale up --ssh

# Automated (using auth key from Tailscale admin console)
sudo tailscale up --authkey=tskey-auth-XXXXX --ssh
```

## ACL Configuration

Configure in Tailscale admin console (https://login.tailscale.com/admin/acls).

Recommended ACL policy:
- Seth's devices → workstation: all ports
- All other nodes → workstation: deny

## Features Used

- **Tailscale SSH** — no SSH keys to manage, identity-based
- **MagicDNS** — access as `imladris` instead of IP
- **ACLs** — identity-based access control

## Ghost Cleanup (prevent `imladris-N` suffix bump)

Every EC2 rebuild would leave a ghost device holding the `imladris` name, so
the next re-enrollment got bumped to `imladris-2`, `-3`, `-4`, …. That broke
every hardcoded reference to `imladris-1`.

Fix: `scripts/tailscale-cleanup-ghosts.sh` runs before `tailscale up` during
both `bootstrap.sh` and the Ansible `tailscale` role. It deletes any tailnet
device named `imladris` or `imladris-N` via the Tailscale REST API.

Prereqs:
- BWS secret `tailscale-api-key` with scopes `devices:core:read` +
  `devices:delete`. Create at
  <https://login.tailscale.com/admin/settings/keys> and store via
  `bws secret create tailscale-api-key <value> <project-id>`.
- The helper fails open: missing token or expired API key logs a warning but
  does not block bootstrap. Manual cleanup path:
  <https://login.tailscale.com/admin/machines>.
