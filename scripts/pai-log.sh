#!/bin/bash
# View PAI/Claude Code activity logs

CMD="${1:-today}"

case "$CMD" in
    today)
        # Show today's session files
        echo "=== Today's Claude Sessions ==="
        echo
        find ~/.claude/debug -name "*.txt" -type f -mtime 0 -exec ls -lh {} \; | \
            awk '{printf "%s %s  %s\n", $6, $7, $9}' | sort
        echo
        echo "Use: pai-log current    # View current session"
        echo "     pai-log list       # List all sessions"
        ;;
    current|latest)
        # View current session
        if [ -L ~/.claude/debug/latest ]; then
            less ~/.claude/debug/latest
        else
            echo "No current session found"
        fi
        ;;
    list)
        # List all sessions with sizes
        echo "=== All Claude Sessions ==="
        ls -lht ~/.claude/debug/*.txt | head -20 | \
            awk '{printf "%s %s  %6s  %s\n", $6, $7, $5, $9}'
        ;;
    prompts)
        # Just show today's prompts
        pai-today
        ;;
    *)
        echo "Usage: pai-log [command]"
        echo
        echo "Commands:"
        echo "  today     Show today's session files (default)"
        echo "  current   View current session transcript"
        echo "  list      List all sessions with sizes"
        echo "  prompts   Show just today's prompts"
        ;;
esac
