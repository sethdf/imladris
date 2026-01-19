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
      powershell  # Microsoft Graph SDK for M365 integration
      libsecret   # Required for PowerShell Graph token caching
      gnome-keyring  # Secret service for OAuth2 token caching (auth-keeper)

      # Container tools
      lazydocker

      # Nix tools
      nixpkgs-fmt
      nix-tree

      # Session & system
      inotify-tools
      mosh

      # Media & transcripts
      yt-dlp

      # Email (optional - auth-keeper is primary)
      # himalaya      # CLI email client (optional, use auth-keeper ms365/google instead)
      # notmuch       # Fast local email search/indexing

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

      # Fabric - AI content extraction
      yt = "fabric -y";  # fabric -y "URL" gets YouTube transcript

      # auth-keeper shortcuts (unified service access)
      ms365 = "auth-keeper ms365";    # MS365 PowerShell (service principal)
      gmail = "auth-keeper google mail";      # Gmail list
      gcal = "auth-keeper google calendar";   # Google Calendar

      # DevBox scripts
      init = "imladris-init";
      check = "imladris-check";
      restore = "imladris-restore";
      status = "imladris-restore status";

      # Claude Code with auto-approve
      claude = "claude --dangerously-skip-permissions";

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

        # Fabric - AI content extraction patterns (Daniel Miessler)
        if [ ! -d "$GHQ_ROOT/github.com/danielmiessler/fabric" ]; then
          ${pkgs.ghq}/bin/ghq get danielmiessler/fabric || true
        fi

        # Anthropic official skills
        if [ ! -d "$GHQ_ROOT/github.com/anthropics/skills" ]; then
          ${pkgs.ghq}/bin/ghq get anthropics/skills || true
        fi

        # Note: Packs are now in curu-skills/packs/ (no separate curu-packs repo)
      '';

      # Install Fabric CLI via go install (not in nixpkgs)
      installFabric = lib.hm.dag.entryAfter [ "writeBoundary" "cloneRepos" ] ''
        export PATH="${pkgs.go}/bin:$PATH"
        export GOPATH="${homeDirectory}/go"
        export GOBIN="${homeDirectory}/.local/bin"
        mkdir -p "$GOBIN"
        # Install fabric if not present or update it
        if [ ! -f "$GOBIN/fabric" ]; then
          ${pkgs.go}/bin/go install github.com/danielmiessler/fabric/cmd/fabric@latest || true
        fi
      '';

      # Create standard directories
      createDirs = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        mkdir -p "${homeDirectory}/bin"
        mkdir -p "${homeDirectory}/.local/bin"
        mkdir -p "${homeDirectory}/.cache/imladris"
        mkdir -p "${homeDirectory}/.config"
        mkdir -p "${homeDirectory}/.config/bws"
        mkdir -p "${homeDirectory}/.config/tmux"
        mkdir -p "${homeDirectory}/.config/simplex-bridge"
        mkdir -p "${homeDirectory}/inbox/simplex"
      '';

      # Symlink tmux session colors script
      installTmuxColors = lib.hm.dag.entryAfter [ "writeBoundary" "cloneRepos" ] ''
        SCRIPT_DIR="${homeDirectory}/repos/github.com/sethdf/imladris/scripts"
        if [ -f "$SCRIPT_DIR/tmux-session-colors.sh" ]; then
          ln -sf "$SCRIPT_DIR/tmux-session-colors.sh" "${homeDirectory}/.config/tmux/session-colors.sh"
        fi
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

      # Install SimpleX Chat CLI (not in nixpkgs, manual download)
      # simplex-chat provides E2E encrypted messaging for mobile AI interface
      installSimplexChat = lib.hm.dag.entryAfter [ "writeBoundary" "createDirs" ] ''
        if [ ! -f "${homeDirectory}/.local/bin/simplex-chat" ]; then
          echo "Installing simplex-chat CLI..."
          ${pkgs.curl}/bin/curl -L -o "${homeDirectory}/.local/bin/simplex-chat" \
            "https://github.com/simplex-chat/simplex-chat/releases/latest/download/simplex-chat-ubuntu-22_04-x86-64" || true
          chmod +x "${homeDirectory}/.local/bin/simplex-chat" 2>/dev/null || true
        fi
      '';

      # Install SimpleX Bridge service and config from curu-skills/packs
      installSimplexBridge = lib.hm.dag.entryAfter [ "writeBoundary" "cloneRepos" "createDirs" ] ''
        PACKS_DIR="${homeDirectory}/repos/github.com/sethdf/curu-skills/packs"
        if [ -d "$PACKS_DIR/simplex-bridge-pack" ]; then
          # Copy config
          if [ -f "$PACKS_DIR/simplex-bridge-pack/src/config/simplex-bridge.yaml" ]; then
            cp "$PACKS_DIR/simplex-bridge-pack/src/config/simplex-bridge.yaml" \
              "${homeDirectory}/.config/simplex-bridge/config.yaml"
          fi
          # Symlink script
          if [ -f "$PACKS_DIR/simplex-bridge-pack/src/scripts/simplex-bridge.sh" ]; then
            ln -sf "$PACKS_DIR/simplex-bridge-pack/src/scripts/simplex-bridge.sh" \
              "${homeDirectory}/bin/simplex-bridge"
            chmod +x "$PACKS_DIR/simplex-bridge-pack/src/scripts/simplex-bridge.sh" 2>/dev/null || true
          fi
          # Copy systemd service
          mkdir -p "${homeDirectory}/.config/systemd/user"
          if [ -f "$PACKS_DIR/simplex-bridge-pack/src/systemd/simplex-bridge.service" ]; then
            cp "$PACKS_DIR/simplex-bridge-pack/src/systemd/simplex-bridge.service" \
              "${homeDirectory}/.config/systemd/user/"
            # Don't enable here - user should enable after linking SimpleX device
          fi
        fi
      '';

      # Note: Claude Code and MCP servers are installed by user-data bootstrap
      # They're not in nixpkgs, so user-data installs them via bun globally
    };

    # Activation scripts - run on home-manager switch
    activation = {
      installPowerShellModules = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        # Install Microsoft.Graph PowerShell modules if not present
        if ! ${pkgs.powershell}/bin/pwsh -Command "Get-Module -ListAvailable Microsoft.Graph.Authentication" &>/dev/null; then
          echo "Installing Microsoft.Graph PowerShell modules..."
          ${pkgs.powershell}/bin/pwsh -Command "
            Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
            Install-Module Microsoft.Graph -Scope CurrentUser -Force -AllowClobber
          "
          echo "Microsoft.Graph modules installed"
        fi
      '';
    };
  };

  # Systemd user services
  systemd.user.services.gnome-keyring = {
    Unit = {
      Description = "GNOME Keyring daemon (secrets only)";
    };
    Service = {
      Type = "simple";
      ExecStart = "${pkgs.gnome-keyring}/bin/gnome-keyring-daemon --start --foreground --components=secrets";
      Restart = "on-failure";
    };
    Install = {
      WantedBy = [ "default.target" ];
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

      # Unlock gnome-keyring for secret storage (auth-keeper Google OAuth cache)
      # Uses empty password for headless server operation
      if command -v gnome-keyring-daemon &>/dev/null; then
        echo "" | gnome-keyring-daemon --unlock &>/dev/null
      fi

      # Update tmux colors when CONTEXT changes (after direnv)
      _update_tmux_context() {
        [[ -n "$TMUX" ]] && ~/.config/tmux/session-colors.sh 2>/dev/null
      }
      autoload -U add-zsh-hook
      add-zsh-hook chpwd _update_tmux_context

      # Auth-keeper: lazy token refresh (authentication)
      [[ -f "$HOME/repos/github.com/sethdf/imladris/scripts/auth-keeper.sh" ]] && \
        source "$HOME/repos/github.com/sethdf/imladris/scripts/auth-keeper.sh"
      [[ -f "$HOME/repos/github.com/sethdf/imladris/scripts/bws-init.sh" ]] && \
        source "$HOME/repos/github.com/sethdf/imladris/scripts/bws-init.sh"

      # GitHub CLI token from BWS (for gh commands)
      if type bws_get &>/dev/null && [[ -z "''${GH_TOKEN:-}" ]]; then
        GH_TOKEN=$(bws_get github-token 2>/dev/null) && export GH_TOKEN
      fi

      # asudo: service access level control (authorization)
      # Must explicitly assume a role before service CLIs work
      [[ -f "$HOME/repos/github.com/sethdf/imladris/scripts/asudo.sh" ]] && \
        source "$HOME/repos/github.com/sethdf/imladris/scripts/asudo.sh"

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

          # Status bar modules
          set -g @catppuccin_status_modules_left "session"
          set -g @catppuccin_status_modules_right "directory date_time"
          set -g @catppuccin_status_left_separator ""
          set -g @catppuccin_status_right_separator ""
          set -g @catppuccin_status_fill "icon"
          set -g @catppuccin_status_connect_separator "no"

          # Window styling
          set -g @catppuccin_window_status_style "rounded"
          set -g @catppuccin_window_default_text "#W"
          set -g @catppuccin_window_current_text "#W"
        '';
      }
    ];

    extraConfig = ''
      # Enable RGB color support
      set -ga terminal-overrides ",*256col*:Tc"

      # Context-based color theming triggered by shell hook (see zsh initExtra)
      # Colors: home=green, work=blue, prod=red, other=purple

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

  # NPM configuration (fix Claude Code auto-update)
  # Note: programs.npm.npmrc removed - option doesn't exist in current home-manager
  # NPM prefix configured via ~/.npmrc directly if needed

  # Starship prompt (replaces oh-my-zsh theme to avoid async git warnings)
  programs.starship = {
    enable = true;
    enableZshIntegration = true;
    settings = {
      # Disable default AWS module - we use custom asudo display
      aws.disabled = true;

      # Service access indicator (set by asudo)
      custom.cloud = {
        when = ''test -n "$ASUDO_CURRENT_PROVIDER"'';
        command = ''echo "$ASUDO_CURRENT_PROVIDER:$ASUDO_CURRENT_ENV"'';
        symbol = "☁️ ";
        style = "bold yellow";
        format = "[$symbol$output ]($style)";
      };

      # Admin warning (red, prominent)
      custom.cloud_admin = {
        when = ''test "$ASUDO_CURRENT_LEVEL" = "admin"'';
        command = ''echo "⚠️ ADMIN"'';
        style = "bold red";
        format = "[$output ]($style)";
      };

      # Context indicators (work/home) - set by direnv, different colors each
      custom.context_work = {
        when = ''test "$CONTEXT" = "work"'';
        command = ''echo "work"'';
        symbol = " ";
        style = "bold blue";
        format = "[$symbol$output ]($style)";
      };

      custom.context_home = {
        when = ''test "$CONTEXT" = "home"'';
        command = ''echo "home"'';
        symbol = " ";
        style = "bold green";
        format = "[$symbol$output ]($style)";
      };

      custom.context_other = {
        when = ''test -n "$CONTEXT" && test "$CONTEXT" != "work" && test "$CONTEXT" != "home"'';
        command = ''echo "$CONTEXT"'';
        symbol = " ";
        style = "bold purple";
        format = "[$symbol$output ]($style)";
      };

      # Format order - explicitly list custom modules
      format = lib.concatStrings [
        "$username"
        "$hostname"
        "\${custom.context_work}"
        "\${custom.context_home}"
        "\${custom.context_other}"
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
