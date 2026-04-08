# PAI Session Container — Phase 1b Docker-Modular Architecture
# Base: node:20-slim (multi-arch: amd64 + arm64)
# See: docs-site/docs/specs/docker-modular.md
FROM node:20-slim

# System packages — tooling required inside Claude Code sessions
RUN apt-get update && apt-get install -y \
    tmux \
    git \
    curl \
    jq \
    fzf \
    ripgrep \
    python3 \
    python3-pip \
    inotify-tools \
    rsync \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI + bun (required for PAI hooks, MCP server, and Windmill scripts)
RUN npm install -g @anthropic-ai/claude-code bun

# Session entrypoint — starts tmux session 'main'
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Pre-create directories as node user so Docker volume mounts inherit correct ownership.
# Docker mounts over existing dirs preserve image permissions; missing dirs get root ownership.
# /pai/inbox and /pai/outbox are created for bind-mount targets (Windmill<->PAI queue).
RUN mkdir -p /home/node/work /home/node/.claude/MEMORY /pai/inbox /pai/outbox \
    && chown -R node:node /home/node /pai/inbox /pai/outbox

# Run as node user (uid 1000 — matches ec2-user uid on host for bind-mount compatibility)
USER node
WORKDIR /home/node

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
