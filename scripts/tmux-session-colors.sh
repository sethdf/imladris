#!/usr/bin/env bash
# Tmux zone-based color theming and session naming
# Called by shell hook when ZONE changes (via direnv)

# Get zone from environment or argument
ZONE="${1:-$ZONE}"

# Skip if not in tmux
[ -z "$TMUX" ] && exit 0

# Catppuccin Mocha colors
GREEN="#a6e3a1"    # home zone
BLUE="#89b4fa"     # work zone
RED="#f38ba8"      # prod/admin zone
PURPLE="#cba6f7"   # other/default zone

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

# Store ZONE in tmux environment for status bar display
tmux set-environment ZONE "$ZONE"
tmux set-environment ZONE_ICON "$ICON"

# Option 1: Rename session to match zone (uncomment to enable)
# This makes session name = zone (e.g., "work", "home")
# tmux rename-session "$ZONE" 2>/dev/null || true

# Option 2: Keep session name but show zone in status (default)
# The status bar will show: [session] 🏠 home

# Update catppuccin theme accent color (session indicator)
tmux set-option -g @catppuccin_session_color "$COLOR"

# Custom session display with zone
tmux set-option -g status-left "#[fg=$COLOR,bold]#[fg=#11111b,bg=$COLOR] #S #[fg=$COLOR,bg=#313244] $ICON $ZONE #[fg=#313244,bg=default] "
tmux set-option -g status-left-length 40

# Update window current number color to match zone
tmux set-option -g @catppuccin_window_current_number_color "$COLOR"

# Update pane borders
tmux set-option -g pane-active-border-style "fg=$COLOR"
tmux set-option -g pane-border-style "fg=#45475a"
