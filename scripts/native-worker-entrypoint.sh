#!/bin/sh
# Create claude CLI symlink if the mounted package exists
if [ -f /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js ]; then
  ln -sf /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js /usr/bin/claude
  chmod +x /usr/bin/claude
fi
# Execute the original entrypoint
exec "$@"
