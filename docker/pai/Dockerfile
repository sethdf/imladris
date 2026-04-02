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

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Session entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Run as node user (uid 1000 — matches ec2-user uid on host)
USER node
WORKDIR /home/node

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
