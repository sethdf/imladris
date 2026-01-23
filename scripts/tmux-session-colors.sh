#!/usr/bin/env bash
# Tmux zone-based color theming with per-session awareness
# Called by:
#   1. Shell hook when ZONE changes (via direnv/chpwd)
#   2. Session-switch hook (client-session-changed)
#   3. Pane focus hook (pane-focus-in)

# Get zone from environment or argument
ZONE="${1:-$ZONE}"

# Skip if not in tmux
[ -z "$TMUX" ] && exit 0

# Get current folder name for display
FOLDER=$(basename "$PWD")
# Get current running command (app)
APP=$(tmux display-message -p '#{pane_current_command}')

# Catppuccin Mocha colors
GREEN="#a6e3a1"    # home zone
BLUE="#89b4fa"     # work zone
RED="#f38ba8"      # prod/admin zone
PURPLE="#cba6f7"   # other/default zone
BG="#313244"       # surface0
BG_DARK="#11111b"  # crust

# Determine color and icon based on zone
case "$ZONE" in
  home)
    COLOR="$GREEN"
    ICON="🏠"
    ;;
  work)
    COLOR="$BLUE"
    ICON="💼"
    ;;
  prod*|admin*)
    COLOR="$RED"
    ICON="⚠️"
    ;;
  *)
    COLOR="$PURPLE"
    ICON="📁"
    ZONE="${ZONE:-none}"
    ;;
esac

# Store ZONE in session-specific environment (not global)
# This allows each session to maintain its own zone state
tmux set-environment ZONE "$ZONE"
tmux set-environment ZONE_ICON "$ICON"
tmux set-environment ZONE_COLOR "$COLOR"

# Session display format: folder (app) | 🏠 home
# Using session-specific options where possible, global for theme colors
tmux set-option -g status-left "#[fg=$COLOR,bold]#[fg=$BG_DARK,bg=$COLOR] $FOLDER #[fg=$COLOR,bg=$BG](#[fg=#cdd6f4,bg=$BG]$APP#[fg=$COLOR,bg=$BG]) #[fg=$BG,bg=default]#[fg=$COLOR] $ICON $ZONE "
tmux set-option -g status-left-length 60

# Update theme accent colors (must be global for catppuccin)
tmux set-option -g @catppuccin_session_color "$COLOR"
tmux set-option -g @catppuccin_window_current_number_color "$COLOR"

# Update pane borders
tmux set-option -g pane-active-border-style "fg=$COLOR"
tmux set-option -g pane-border-style "fg=#45475a"
