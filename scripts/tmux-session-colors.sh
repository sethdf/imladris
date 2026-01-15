#!/usr/bin/env bash
# Tmux context-based color theming
# Called by shell hook when CONTEXT changes (via direnv)

# Get context from environment or argument
CONTEXT="${1:-$CONTEXT}"

# Skip if not in tmux
[ -z "$TMUX" ] && exit 0

# Catppuccin Mocha colors
GREEN="#a6e3a1"    # home context
BLUE="#89b4fa"     # work context
RED="#f38ba8"      # prod/admin context
PURPLE="#cba6f7"   # other context
PEACH="#fab387"    # warning accent

# Determine color based on context
case "$CONTEXT" in
  home)
    COLOR="$GREEN"
    ;;
  work)
    COLOR="$BLUE"
    ;;
  prod*|admin*)
    COLOR="$RED"
    ;;
  *)
    COLOR="$PURPLE"
    ;;
esac

# Apply colors to tmux
tmux set-option -g status-style "bg=default,fg=$COLOR"
tmux set-option -g pane-active-border-style "fg=$COLOR"
tmux set-option -g pane-border-style "fg=#45475a"
tmux set-option -g message-style "bg=$COLOR,fg=#1e1e2e"

# Window status colors - current window prominent with background
tmux set-option -g window-status-current-style "fg=#1e1e2e,bg=$COLOR,bold"
tmux set-option -g window-status-current-format " #I:#W "
tmux set-option -g window-status-style "fg=#585b70"
tmux set-option -g window-status-format " #I:#W "
