#!/bin/bash
# Show today's Claude Code activity

TODAY=$(date +%Y-%m-%d)
HISTORY_FILE="$HOME/.claude/history.jsonl"

if [ ! -f "$HISTORY_FILE" ]; then
    echo "No history file found at $HISTORY_FILE"
    exit 1
fi

echo "=== Claude Code Activity for $TODAY ==="
echo

# Show today's prompts with timestamps
cat "$HISTORY_FILE" | jq -r --arg today "$(date +%s -d 'today 00:00:00')" \
    'select(.timestamp >= ($today | tonumber * 1000)) | 
     "\((.timestamp / 1000) | strftime("%H:%M:%S")) - \(.display)"' 2>/dev/null

echo
echo "Total prompts today: $(cat "$HISTORY_FILE" | jq -r --arg today "$(date +%s -d 'today 00:00:00')" 'select(.timestamp >= ($today | tonumber * 1000))' | wc -l)"
