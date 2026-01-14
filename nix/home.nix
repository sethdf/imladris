{ config, pkgs, lib, username, homeDirectory, ... }:

{
  home = {
    inherit username homeDirectory;
    stateVersion = "24.05";

    # Packages to install
    packages = with pkgs; [
      # Core utilities
      curl
      wget
      unzip
      jq
      yq
      htop
      ncdu
      tree

      # Git ecosystem
      git
      git-crypt
      gh
      lazygit
      delta

      # Search & navigation
      ripgrep
      fd
      bat
      eza
      fzf

      # Development
      gnumake
      gcc
      nodejs_20
      python311
      python311Packages.pip
      bun
      go

      # Cloud CLIs
      awscli2
      azure-cli
      google-cloud-sdk

      # Container tools
      lazydocker

      # Nix tools
      nixpkgs-fmt
      nix-tree

      # Session & system
      inotify-tools
      mosh

      # Version management
      mise

      # Repo management
      ghq

      # Prompt
      starship

      # Notifications
      signal-cli
    ];

    # Environment variables
    sessionVariables = {
      EDITOR = "vim";
      VISUAL = "vim";
      GHQ_ROOT = "${homeDirectory}/repos";
      HISTSIZE = "50000";
      SAVEHIST = "50000";
      # AWS default region
      AWS_REGION = "us-east-1";
      # Claude Code backend managed by claude-backend tool
      # Default: personal > team > bedrock (for security/logging)
    };

    # Shell aliases (shared across shells)
    shellAliases = {
      # Modern replacements
      ls = "eza";
      ll = "eza -la";
      la = "eza -a";
      lt = "eza --tree";
      cat = "bat --paging=never";

      # Tool shortcuts
      lg = "lazygit";
      ld = "lazydocker";
      g = "git";
      tf = "terraform";

      # DevBox scripts
      init = "imladris-init";
      check = "imladris-check";
      restore = "imladris-restore";
      status = "imladris-restore status";

      # Tmux
      ta = "tmux attach -t main || tmux new -s main";
      tl = "tmux list-sessions";
      tn = "tmux new -s";

      # Navigation
      ".." = "cd ..";
      "..." = "cd ../..";
      "~" = "cd ~";

      # Safety
      rm = "rm -i";
      cp = "cp -i";
      mv = "mv -i";

      # Signal interface
      sig = "signal-interface.sh";
    };

    # Activation script - runs on home-manager switch
    activation = {
      # Clone repos via ghq if not present
      cloneRepos = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        export PATH="${pkgs.git}/bin:${pkgs.ghq}/bin:$PATH"
        export GHQ_ROOT="${homeDirectory}/repos"

        # Ensure ghq root exists
        mkdir -p "$GHQ_ROOT"

        # Clone repos if not present
        if [ ! -d "$GHQ_ROOT/github.com/sethdf/imladris" ]; then
          ${pkgs.ghq}/bin/ghq get -p sethdf/imladris || true
        fi

        # Curu skills - "Skill" in Elvish (from Curunír, "Man of Skill")
        if [ ! -d "$GHQ_ROOT/github.com/sethdf/curu-skills" ]; then
          ${pkgs.ghq}/bin/ghq get -p sethdf/curu-skills || true
        fi

        # PAI framework (Daniel Miessler's Personal AI Infrastructure)
        if [ ! -d "$GHQ_ROOT/github.com/danielmiessler/Personal_AI_Infrastructure" ]; then
          ${pkgs.ghq}/bin/ghq get danielmiessler/Personal_AI_Infrastructure || true
        fi

        # Anthropic official skills
        if [ ! -d "$GHQ_ROOT/github.com/anthropics/skills" ]; then
          ${pkgs.ghq}/bin/ghq get anthropics/skills || true
        fi
      '';

      # Create standard directories
      createDirs = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        mkdir -p "${homeDirectory}/bin"
        mkdir -p "${homeDirectory}/.local/bin"
        mkdir -p "${homeDirectory}/.cache/imladris"
        mkdir -p "${homeDirectory}/.config"
        mkdir -p "${homeDirectory}/.config/bws"
      '';

      # Install Signal interface systemd service
      installSignalService = lib.hm.dag.entryAfter [ "writeBoundary" "cloneRepos" ] ''
        mkdir -p "${homeDirectory}/.config/systemd/user"
        SCRIPT_DIR="${homeDirectory}/repos/github.com/sethdf/imladris/scripts"
        if [ -f "$SCRIPT_DIR/signal-interface.service" ]; then
          cp "$SCRIPT_DIR/signal-interface.service" "${homeDirectory}/.config/systemd/user/"
          # Don't enable here - user should enable after linking signal-cli
        fi
      '';

      # Note: Claude Code and MCP servers are installed by user-data bootstrap
      # They're not in nixpkgs, so user-data installs them via bun globally
    };
  };

  # Program configurations

  programs.home-manager.enable = true;

  # Zsh configuration
  programs.zsh = {
    enable = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;
    enableCompletion = true;

    history = {
      size = 50000;
      save = 50000;
      share = true;
      ignoreDups = true;
      ignoreAllDups = true;
      ignoreSpace = true;
      extended = true;
    };

    # oh-my-zsh disabled - using starship for prompt, zoxide for z, fzf via programs.fzf
    # Completions for docker/kubectl/aws/terraform can be added manually if needed

    initExtra = ''
      # Tool initialization
      eval "$(mise activate zsh)"
      eval "$(zoxide init zsh)"
      eval "$(direnv hook zsh)"

      # Auth-keeper: lazy token refresh (authentication)
      [[ -f "$HOME/repos/github.com/sethdf/imladris/scripts/auth-keeper.sh" ]] && \
        source "$HOME/repos/github.com/sethdf/imladris/scripts/auth-keeper.sh"
      [[ -f "$HOME/repos/github.com/sethdf/imladris/scripts/bws-init.sh" ]] && \
        source "$HOME/repos/github.com/sethdf/imladris/scripts/bws-init.sh"

      # GitHub CLI token from BWS (for gh commands)
      if type bws_get &>/dev/null && [[ -z "''${GH_TOKEN:-}" ]]; then
        GH_TOKEN=$(bws_get github-token 2>/dev/null) && export GH_TOKEN
      fi

      # Cloud-assume: access level control (authorization)
      # Must explicitly assume a role before cloud CLIs work
      [[ -f "$HOME/repos/github.com/sethdf/imladris/scripts/cloud-assume.sh" ]] && \
        source "$HOME/repos/github.com/sethdf/imladris/scripts/cloud-assume.sh"

      # Claude-backend: switch between Bedrock/Team/Personal plans
      [[ -f "$HOME/repos/github.com/sethdf/imladris/scripts/claude-backend.sh" ]] && \
        source "$HOME/repos/github.com/sethdf/imladris/scripts/claude-backend.sh"

      # Apply saved Claude backend (personal by default for better security/logging)
      if type _cb_apply_backend &>/dev/null; then
        _cb_apply_backend 2>/dev/null
      fi

      # Imladris shell helpers (created by imladris-init)
      [[ -f "$HOME/.config/imladris/shell-helpers.sh" ]] && \
        source "$HOME/.config/imladris/shell-helpers.sh"

      # GHQ + FZF integration
      ghq-cd() {
        local dir
        dir=$(ghq list | fzf --preview "ls -la $(ghq root)/{}" --height 40%)
        if [ -n "$dir" ]; then
          cd "$(ghq root)/$dir"
        fi
      }
      alias repos="ghq-cd"

      # FZF configuration
      export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'
      export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
      export FZF_ALT_C_COMMAND='fd --type d --hidden --follow --exclude .git'

      # Auto-attach to tmux on SSH (unless disabled)
      # Use ${VAR:-} syntax to handle unset variables in strict mode
      if [ -n "''${SSH_CONNECTION:-}" ] && [ -z "''${TMUX:-}" ] && [ -z "''${DEVBOX_NO_TMUX:-}" ]; then
        tmux attach -t main 2>/dev/null || tmux new -s main
      fi
    '';

    profileExtra = ''
      # Ensure PATH includes user bins, bun global, and host scripts
      export PATH="$HOME/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/repos/github.com/sethdf/imladris/scripts:$PATH"
    '';
  };

  # Git configuration
  programs.git = {
    enable = true;
    userName = "Seth";
    # userEmail configured separately or via git config

    delta = {
      enable = true;
      options = {
        navigate = true;
        side-by-side = true;
        line-numbers = true;
      };
    };

    extraConfig = {
      init.defaultBranch = "main";
      pull.rebase = false;
      credential.helper = "cache --timeout=86400";
      core.editor = "vim";
      push.autoSetupRemote = true;
    };

    aliases = {
      co = "checkout";
      br = "branch";
      ci = "commit";
      st = "status";
      lg = "log --oneline --graph --decorate";
      last = "log -1 HEAD";
      unstage = "reset HEAD --";
    };
  };

  # Tmux configuration
  programs.tmux = {
    enable = true;
    terminal = "tmux-256color";
    shell = "${pkgs.zsh}/bin/zsh";
    baseIndex = 1;
    historyLimit = 50000;
    escapeTime = 10;
    keyMode = "vi";
    mouse = true;

    plugins = with pkgs.tmuxPlugins; [
      sensible
      resurrect
      continuum
      yank
      {
        plugin = catppuccin;
        extraConfig = ''
          set -g @catppuccin_flavor 'mocha'
        '';
      }
    ];

    extraConfig = ''
      # Enable RGB color support
      set -ga terminal-overrides ",*256col*:Tc"

      # Pane splitting with | and -
      bind | split-window -h -c "#{pane_current_path}"
      bind - split-window -v -c "#{pane_current_path}"

      # Vim-style pane navigation
      bind h select-pane -L
      bind j select-pane -D
      bind k select-pane -U
      bind l select-pane -R

      # Resize panes with HJKL
      bind -r H resize-pane -L 5
      bind -r J resize-pane -D 5
      bind -r K resize-pane -U 5
      bind -r L resize-pane -R 5

      # Quick reload
      bind r source-file ~/.tmux.conf \; display "Reloaded!"

      # Resurrect settings
      set -g @resurrect-capture-pane-contents 'on'
      set -g @resurrect-strategy-vim 'session'
      set -g @resurrect-strategy-nvim 'session'
      set -g @resurrect-processes 'vim nvim man less tail top htop ssh'

      # Continuum settings
      set -g @continuum-save-interval '5'
      set -g @continuum-restore 'on'

      # Focus events for vim
      set -g focus-events on
    '';
  };

  # FZF configuration
  programs.fzf = {
    enable = true;
    enableZshIntegration = true;
    defaultCommand = "fd --type f --hidden --follow --exclude .git";
    defaultOptions = [
      "--height 40%"
      "--layout=reverse"
      "--border"
    ];
  };

  # Direnv configuration
  programs.direnv = {
    enable = true;
    enableZshIntegration = true;
    nix-direnv.enable = true;
  };

  # Zoxide configuration
  programs.zoxide = {
    enable = true;
    enableZshIntegration = true;
  };

  # Bat configuration
  programs.bat = {
    enable = true;
    config = {
      theme = "TwoDark";
      pager = "less -FR";
    };
  };

  # Starship prompt (replaces oh-my-zsh theme to avoid async git warnings)
  programs.starship = {
    enable = true;
    enableZshIntegration = true;
    settings = {
      # Disable default AWS module - we use custom cloud-assume display
      aws.disabled = true;

      # Cloud access indicator (set by cloud-assume)
      custom.cloud = {
        when = ''test -n "$CLOUD_CURRENT_PROVIDER"'';
        command = ''echo "$CLOUD_CURRENT_PROVIDER:$CLOUD_CURRENT_ENV"'';
        symbol = "☁️ ";
        style = "bold yellow";
        format = "[$symbol$output ]($style)";
      };

      # Admin warning (red, prominent)
      custom.cloud_admin = {
        when = ''test "$CLOUD_CURRENT_LEVEL" = "admin"'';
        command = ''echo "⚠️ ADMIN"'';
        style = "bold red";
        format = "[$output ]($style)";
      };

      # Format order - explicitly list custom modules
      format = lib.concatStrings [
        "$username"
        "$hostname"
        "$directory"
        "$git_branch"
        "$git_status"
        "\${custom.cloud}"
        "\${custom.cloud_admin}"
        "$cmd_duration"
        "$line_break"
        "$character"
      ];
    };
  };
}
