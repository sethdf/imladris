FROM node:20-slim

# System packages
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

# Claude Code CLI + bun (required for PAI hooks and MCP server)
RUN npm install -g @anthropic-ai/claude-code bun

# Session entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Pre-create directories as node user so Docker volume mounts inherit correct ownership
# (Docker mounts over existing dirs preserve image permissions; missing dirs get root ownership)
RUN mkdir -p /home/node/work /home/node/.claude/MEMORY \
    && chown -R node:node /home/node

# Run as node user (uid 1000 — matches ec2-user uid on host)
USER node
WORKDIR /home/node

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
