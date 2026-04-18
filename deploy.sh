#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Deploy Imladris to any Linux box
# =============================================================================
# Works on: Amazon Linux 2023, Ubuntu 22.04+, Debian 12+
# Targets:  AWS EC2, Hetzner Cloud/Dedicated, Proxmox LXC/VM, bare metal
#
# Usage:
#   ./deploy.sh                                    # interactive (prompts for keys)
#   ./deploy.sh --tailscale-key tskey-auth-...     # headless with Tailscale key
#   ./deploy.sh --bws-token 0.e377a...             # headless with BWS token
#   ./deploy.sh --env-file /path/to/.env           # use pre-made env file
#
# What it does:
#   1. Installs Docker + Compose plugin
#   2. Installs Tailscale + authenticates
#   3. Installs Bun, Claude Code, BWS CLI
#   4. Clones imladris repo
#   5. Sets up PAI (symlinks modules/pai/ → ~/.claude/)
#   6. Generates .env for docker-compose
#   7. Builds custom Postgres image (pgvector + pgml + AGE)
#   8. Starts all services via docker compose
#
# Idempotent — safe to re-run. No AWS SDK/CLI required.
# =============================================================================

set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
BLUE='\033[38;2;59;130;246m'
GREEN='\033[38;2;34;197;94m'
YELLOW='\033[38;2;234;179;8m'
RED='\033[38;2;239;68;68m'
GRAY='\033[38;2;100;116;139m'
RESET='\033[0m'
BOLD='\033[1m'

info()    { echo -e "  ${BLUE}ℹ${RESET} $1"; }
ok()      { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail()    { echo -e "  ${RED}✗${RESET} $1"; }
step()    { echo -e "\n${BOLD}${BLUE}━━━ $1 ━━━${RESET}"; }

# ── Config ───────────────────────────────────────────────────────────────────
IMLADRIS_USER="${IMLADRIS_USER:-$(whoami)}"
IMLADRIS_HOME="${IMLADRIS_HOME:-$(eval echo ~$IMLADRIS_USER)}"
IMLADRIS_REPO="${IMLADRIS_REPO:-${IMLADRIS_HOME}/repos/imladris}"
IMLADRIS_HOSTNAME="${IMLADRIS_HOSTNAME:-imladris}"
TAILSCALE_KEY=""
BWS_TOKEN=""
ENV_FILE=""
SKIP_TAILSCALE=0
SKIP_CLAUDE=0

# ── Parse args ───────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --tailscale-key=*) TAILSCALE_KEY="${arg#*=}" ;;
    --bws-token=*)     BWS_TOKEN="${arg#*=}" ;;
    --env-file=*)      ENV_FILE="${arg#*=}" ;;
    --skip-tailscale)  SKIP_TAILSCALE=1 ;;
    --skip-claude)     SKIP_CLAUDE=1 ;;
    --help|-h)
      sed -n '/^# Usage:/,/^# =====/p' "$0" | head -20
      exit 0 ;;
  esac
done

# ── Detect OS ────────────────────────────────────────────────────────────────
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
    OS_VERSION="${VERSION_ID:-unknown}"
  else
    OS_ID="unknown"
    OS_VERSION="unknown"
  fi
  ARCH="$(uname -m)"
  info "Detected: ${OS_ID} ${OS_VERSION} (${ARCH})"
}

# ── Install Docker ───────────────────────────────────────────────────────────
install_docker() {
  step "Docker"
  if command -v docker >/dev/null 2>&1; then
    ok "Docker already installed: $(docker --version | head -1)"
    # Ensure compose plugin
    if docker compose version >/dev/null 2>&1; then
      ok "Compose plugin: $(docker compose version)"
    else
      install_compose_plugin
    fi
    return
  fi

  info "Installing Docker..."
  case "$OS_ID" in
    amzn)
      sudo dnf install -y docker
      ;;
    ubuntu|debian)
      curl -fsSL https://get.docker.com | sudo sh
      ;;
    *)
      curl -fsSL https://get.docker.com | sudo sh
      ;;
  esac

  sudo systemctl enable --now docker
  sudo usermod -aG docker "$IMLADRIS_USER"

  # Install compose plugin (AL2023 doesn't package it — install from GitHub)
  install_compose_plugin

  ok "Docker installed"
}

install_compose_plugin() {
  if docker compose version >/dev/null 2>&1; then return; fi
  info "Installing Docker Compose plugin..."
  local COMPOSE_VERSION="v2.32.4"
  local COMPOSE_ARCH="x86_64"
  [ "$(uname -m)" = "aarch64" ] && COMPOSE_ARCH="aarch64"
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  sudo curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  ok "Compose plugin: $(docker compose version 2>/dev/null || echo 'installed')"
}

# ── Install Tailscale ────────────────────────────────────────────────────────
install_tailscale() {
  step "Tailscale"
  if [ "$SKIP_TAILSCALE" = "1" ]; then
    warn "Skipped (--skip-tailscale)"
    return
  fi

  if ! command -v tailscale >/dev/null 2>&1; then
    info "Installing Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sudo sh
  fi

  # Authenticate if key provided and not already connected
  if tailscale status >/dev/null 2>&1; then
    ok "Tailscale already connected: $(tailscale status --self --peers=false | awk '{print $2}')"
  elif [ -n "$TAILSCALE_KEY" ]; then
    info "Authenticating Tailscale..."
    sudo tailscale up --authkey "$TAILSCALE_KEY" --hostname "$IMLADRIS_HOSTNAME" --ssh
    ok "Tailscale connected as ${IMLADRIS_HOSTNAME}"
  else
    warn "Tailscale installed but not authenticated. Run: sudo tailscale up --authkey <key> --hostname ${IMLADRIS_HOSTNAME} --ssh"
  fi
}

# ── Install Bun ──────────────────────────────────────────────────────────────
install_bun() {
  step "Bun"
  if command -v bun >/dev/null 2>&1; then
    ok "Bun already installed: $(bun --version)"
    return
  fi
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="${IMLADRIS_HOME}/.bun/bin:$PATH"
  ok "Bun installed: $(bun --version)"
}

# ── Install Claude Code ──────────────────────────────────────────────────────
install_claude() {
  step "Claude Code"
  if [ "$SKIP_CLAUDE" = "1" ]; then
    warn "Skipped (--skip-claude)"
    return
  fi
  if command -v claude >/dev/null 2>&1; then
    ok "Claude Code already installed"
    return
  fi
  info "Installing Claude Code..."
  npm install -g @anthropic-ai/claude-code 2>/dev/null || bun install -g @anthropic-ai/claude-code
  ok "Claude Code installed"
}

# ── Install BWS CLI ──────────────────────────────────────────────────────────
install_bws() {
  step "Bitwarden Secrets (BWS)"
  if command -v bws >/dev/null 2>&1; then
    ok "BWS already installed"
  else
    info "Installing BWS CLI..."
    case "$ARCH" in
      x86_64)  BWS_ARCH="x86_64-unknown-linux-gnu" ;;
      aarch64) BWS_ARCH="aarch64-unknown-linux-gnu" ;;
      *) fail "Unsupported arch for BWS: $ARCH"; return ;;
    esac
    BWS_VERSION="1.0.0"
    curl -fsSL "https://github.com/bitwarden/sdk/releases/download/bws-v${BWS_VERSION}/bws-${BWS_ARCH}-${BWS_VERSION}.zip" -o /tmp/bws.zip
    cd /tmp && unzip -o bws.zip && sudo mv bws /usr/local/bin/bws && sudo chmod +x /usr/local/bin/bws
    rm -f /tmp/bws.zip
    ok "BWS installed"
  fi

  if [ -n "$BWS_TOKEN" ]; then
    export BWS_ACCESS_TOKEN="$BWS_TOKEN"
    ok "BWS token set"
  elif [ -z "${BWS_ACCESS_TOKEN:-}" ]; then
    warn "BWS_ACCESS_TOKEN not set. Some features will be unavailable."
  fi
}

# ── Clone Repo ───────────────────────────────────────────────────────────────
clone_repo() {
  step "Imladris Repo"
  if [ -d "${IMLADRIS_REPO}/.git" ]; then
    ok "Repo already at ${IMLADRIS_REPO}"
    cd "$IMLADRIS_REPO" && git pull --ff-only 2>/dev/null || true
    return
  fi
  info "Cloning imladris..."
  mkdir -p "$(dirname "$IMLADRIS_REPO")"
  git clone https://github.com/sethdf/imladris.git "$IMLADRIS_REPO"
  ok "Cloned to ${IMLADRIS_REPO}"
}

# ── Set up PAI ───────────────────────────────────────────────────────────────
setup_pai() {
  step "PAI Setup"
  if [ -x "${IMLADRIS_REPO}/modules/pai/link.sh" ]; then
    bash "${IMLADRIS_REPO}/modules/pai/link.sh"
    ok "PAI symlinks created"
  else
    warn "modules/pai/link.sh not found — skipping PAI setup"
  fi

  # Install external deps (Ruflo, PAI upstream)
  if [ -x "${IMLADRIS_REPO}/scripts/install-deps.sh" ]; then
    bash "${IMLADRIS_REPO}/scripts/install-deps.sh"
    ok "External dependencies installed"
  fi
}

# ── Generate .env ────────────────────────────────────────────────────────────
generate_env() {
  step "Environment"
  local env_path="${IMLADRIS_REPO}/.env"

  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "$env_path"
    ok "Using provided .env from ${ENV_FILE}"
    return
  fi

  if [ -f "$env_path" ]; then
    ok ".env already exists"
    return
  fi

  info "Generating .env..."
  local db_pass
  db_pass="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
  local admin_secret
  admin_secret="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"

  cat > "$env_path" <<ENVEOF
# Imladris docker-compose environment — generated by deploy.sh
# NEVER commit this file to git.
WINDMILL_DB_PASSWORD=${db_pass}
WINDMILL_ADMIN_SECRET=${admin_secret}
ENVEOF

  chmod 600 "$env_path"
  ok ".env generated (Windmill DB password + admin secret)"
}

# ── Create directories ───────────────────────────────────────────────────────
create_dirs() {
  step "Directories"
  local dirs=(
    "${IMLADRIS_HOME}/.windmill/postgres"
    "${IMLADRIS_HOME}/.claude"
    "${IMLADRIS_HOME}/.claude/MEMORY"
    "${IMLADRIS_HOME}/.claude/projects"
    "/pai/memory/STATE"
  )

  for d in "${dirs[@]}"; do
    if [ ! -d "$d" ]; then
      sudo mkdir -p "$d"
      sudo chown "$IMLADRIS_USER:$IMLADRIS_USER" "$d"
      info "Created $d"
    fi
  done

  # Cache dir — use NVMe if available, otherwise local
  if [ -d "/local" ]; then
    ok "NVMe instance store detected at /local"
  else
    sudo mkdir -p /local/cache
    sudo chown "$IMLADRIS_USER:$IMLADRIS_USER" /local/cache
    info "Created /local/cache (no NVMe — using root filesystem)"
  fi

  # Install tmux + mosh if missing
  for pkg in tmux mosh; do
    if ! command -v "$pkg" >/dev/null 2>&1; then
      case "$OS_ID" in
        amzn) sudo dnf install -y "$pkg" 2>/dev/null ;;
        ubuntu|debian) sudo apt-get install -y "$pkg" 2>/dev/null ;;
      esac
    fi
  done

  # tmux auto-attach on SSH login
  if ! grep -q "tmux auto-attach" "${IMLADRIS_HOME}/.bashrc" 2>/dev/null; then
    cat >> "${IMLADRIS_HOME}/.bashrc" <<'TMUXRC'

# BEGIN - tmux auto-attach
if command -v tmux &>/dev/null && [ -n "$SSH_CONNECTION" ] && [ -z "$TMUX" ]; then
  tmux attach -t work 2>/dev/null || tmux new -s work
fi
# END - tmux auto-attach
TMUXRC
    info "tmux auto-attach added to .bashrc"
  fi

  ok "Directories ready"
}

# ── Build Postgres image ─────────────────────────────────────────────────────
build_postgres() {
  step "Postgres Image"
  if docker image inspect imladris/postgres:pg16 >/dev/null 2>&1; then
    ok "imladris/postgres:pg16 already built"
    return
  fi

  local dockerfile="${IMLADRIS_REPO}/docker/postgres-pgml/Dockerfile"
  if [ ! -f "$dockerfile" ]; then
    fail "Dockerfile not found at ${dockerfile}"
    return 1
  fi

  info "Building imladris/postgres:pg16 (this takes 5-15 min on first run)..."
  docker build -t imladris/postgres:pg16 -f "$dockerfile" "${IMLADRIS_REPO}/docker/postgres-pgml/"
  ok "Postgres image built"
}

# ── Start services ───────────────────────────────────────────────────────────
start_services() {
  step "Services"
  cd "$IMLADRIS_REPO"

  info "Starting docker compose..."
  docker compose up -d
  ok "All services started"

  # Wait for Windmill health
  info "Waiting for Windmill..."
  local retries=30
  while [ $retries -gt 0 ]; do
    if curl -sf http://localhost:8000/api/version >/dev/null 2>&1; then
      ok "Windmill healthy"
      break
    fi
    retries=$((retries - 1))
    sleep 2
  done
  [ $retries -eq 0 ] && warn "Windmill not healthy after 60s — check docker compose logs"
}

# ── Set up pai-sync daemon ───────────────────────────────────────────────────
setup_pai_sync() {
  step "PAI Sync Daemon"
  local sync_dir="${IMLADRIS_REPO}/scripts/pai-sync"
  if [ ! -f "${sync_dir}/daemon.ts" ]; then
    warn "pai-sync source not found — skipping"
    return
  fi

  # Build daemon binary
  if [ ! -f /usr/local/bin/pai-sync-daemon ] || [ "${sync_dir}/daemon.ts" -nt /usr/local/bin/pai-sync-daemon ]; then
    info "Compiling pai-sync daemon..."
    cd "$sync_dir" && bun install --frozen-lockfile 2>/dev/null || bun install
    bun build --compile daemon.ts --outfile /tmp/pai-sync-daemon
    sudo mv /tmp/pai-sync-daemon /usr/local/bin/pai-sync-daemon
    sudo chmod 755 /usr/local/bin/pai-sync-daemon
    ok "pai-sync daemon compiled"
  fi

  if [ ! -f /usr/local/bin/pai-sync ]; then
    bun build --compile cli.ts --outfile /tmp/pai-sync
    sudo mv /tmp/pai-sync /usr/local/bin/pai-sync
    sudo chmod 755 /usr/local/bin/pai-sync
  fi

  # Create env file
  local db_pass
  db_pass="$(grep WINDMILL_DB_PASSWORD "${IMLADRIS_REPO}/.env" | cut -d= -f2)"
  sudo mkdir -p /etc/pai-sync
  sudo tee /etc/pai-sync/env > /dev/null <<SYNCENV
POSTGRES_URL=postgresql://postgres:${db_pass}@127.0.0.1:5432/pai
PAI_SYNC_WATCH_ROOT=${IMLADRIS_HOME}/.claude/MEMORY
PAI_SYNC_EXTRA_WATCH=${IMLADRIS_HOME}/.claude/projects
PAI_SYNC_MACHINE_ID=${IMLADRIS_HOSTNAME}
PAI_EMBED_BATCH_SIZE=20
PAI_EMBED_INTERVAL_MS=60000
SYNCENV
  sudo chmod 640 /etc/pai-sync/env

  # Install systemd service
  sudo tee /etc/systemd/system/pai-sync.service > /dev/null <<SVCEOF
[Unit]
Description=PAI Memory Sync Daemon
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${IMLADRIS_USER}
ExecStart=/usr/local/bin/pai-sync-daemon
Restart=always
RestartSec=5
WatchdogSec=120
EnvironmentFile=/etc/pai-sync/env

[Install]
WantedBy=multi-user.target
SVCEOF

  sudo systemctl daemon-reload
  sudo systemctl enable --now pai-sync.service
  ok "pai-sync daemon running"
}

# ── Summary ──────────────────────────────────────────────────────────────────
print_summary() {
  echo ""
  echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}  Imladris deployed successfully${RESET}"
  echo -e "${GREEN}═══════════════════════════════════════════════${RESET}"
  echo ""
  echo -e "  ${GRAY}Windmill:${RESET}   http://localhost:8000"
  echo -e "  ${GRAY}Tailscale:${RESET}  $(tailscale status --self --peers=false 2>/dev/null | awk '{print $1}' || echo 'not connected')"
  echo -e "  ${GRAY}Repo:${RESET}       ${IMLADRIS_REPO}"
  echo -e "  ${GRAY}PAI:${RESET}        ~/.claude/ → modules/pai/"
  echo -e "  ${GRAY}Postgres:${RESET}   localhost:5432 (user: postgres)"
  echo ""
  echo -e "  ${GRAY}Next steps:${RESET}"
  echo -e "    1. Open Windmill at http://localhost:8000"
  echo -e "    2. Start Claude Code: claude"
  echo -e "    3. Connect via Tailscale: ssh ${IMLADRIS_USER}@${IMLADRIS_HOSTNAME}"
  echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo -e "\n${BOLD}${BLUE}Imladris Deploy${RESET} ${GRAY}— portable cloud workstation${RESET}\n"

  detect_os
  install_docker
  install_tailscale
  install_bun
  install_claude
  install_bws
  clone_repo
  create_dirs
  setup_pai
  generate_env
  build_postgres
  start_services
  setup_pai_sync
  print_summary
}

main "$@"
