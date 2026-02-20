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
