#!/usr/bin/env bash
# Tmux session-based color theming
# Called by tmux hooks on session-created and client-session-changed

SESSION_NAME=$(tmux display-message -p '#S')

# Catppuccin Mocha colors
GREEN="#a6e3a1"    # main/home sessions
BLUE="#89b4fa"     # work sessions
RED="#f38ba8"      # prod/admin sessions
PURPLE="#cba6f7"   # other sessions
PEACH="#fab387"    # warning accent

# Determine color based on session name
case "$SESSION_NAME" in
  main|home|default)
    COLOR="$GREEN"
    ;;
  work|dev|project*)
    COLOR="$BLUE"
    ;;
  prod*|admin*|root*)
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

# Window status colors
tmux set-option -g window-status-current-style "fg=$COLOR,bold"
tmux set-option -g window-status-style "fg=#6c7086"
