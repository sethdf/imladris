#!/usr/bin/env bash
# Tmux context-based color theming (works with catppuccin)
# Called by shell hook when ZONE changes (via direnv)

# Get context from environment or argument
ZONE="${1:-$ZONE}"

# Skip if not in tmux
[ -z "$TMUX" ] && exit 0

# Catppuccin Mocha colors
GREEN="#a6e3a1"    # home context
BLUE="#89b4fa"     # work context
RED="#f38ba8"      # prod/admin context
PURPLE="#cba6f7"   # other/default context

# Determine color based on context
case "$ZONE" in
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

# Update catppuccin theme accent color (session indicator)
tmux set-option -g @catppuccin_session_color "$COLOR"

# Update the session status module to use our color
tmux set-option -g @catppuccin_status_session "#[fg=$COLOR]#[fg=#11111b,bg=$COLOR] #[fg=#cdd6f4,bg=#313244]#{E:@catppuccin_session_text}#[fg=#313244] "

# Update window current number color to match context
tmux set-option -g @catppuccin_window_current_number_color "$COLOR"

# Update pane borders
tmux set-option -g pane-active-border-style "fg=$COLOR"
tmux set-option -g pane-border-style "fg=#45475a"
