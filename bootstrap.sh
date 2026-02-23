#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Imladris v2 Bootstrap
# =============================================================================
# Cloud workstation bootstrap for Amazon Linux 2023 / Fedora-based EC2.
# Runs AFTER UserData has installed basic deps and cloned the repo.
# Idempotent — safe to re-run at any time.
#
# Architecture decisions enforced:
#   D34 — Repos ARE production via symlinks
#   D13 — Bitwarden Secrets is source of truth
#   D18 — Windmill via Docker Compose on same EC2
#   D33 — Tailscale-only network access
# =============================================================================

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOS_DIR="$HOME/repos"
readonly CLAUDE_DIR="$HOME/.claude"
readonly IMLADRIS_DIR="$REPOS_DIR/imladris"
readonly LOG_FILE="/tmp/imladris-bootstrap-$(date +%Y%m%d-%H%M%S).log"

# Colors for terminal output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly BOLD='\033[1m'
readonly NC='\033[0m' # No Color

# Track what was installed vs already present
declare -a INSTALLED=()
declare -a SKIPPED=()
declare -a WARNINGS=()

# =============================================================================
# Utility Functions
# =============================================================================

log() {
  local level="$1"
  shift
  local msg="$*"
  local timestamp
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$timestamp] [$level] $msg" >> "$LOG_FILE"

  case "$level" in
    INFO)  echo -e "${BLUE}[INFO]${NC}  $msg" ;;
    OK)    echo -e "${GREEN}[OK]${NC}    $msg" ;;
    SKIP)  echo -e "${YELLOW}[SKIP]${NC}  $msg" ;;
    WARN)  echo -e "${YELLOW}[WARN]${NC}  $msg" ;;
    ERROR) echo -e "${RED}[ERROR]${NC} $msg" >&2 ;;
    STEP)  echo -e "\n${BOLD}=== $msg ===${NC}" ;;
  esac
}

command_exists() {
  command -v "$1" &>/dev/null
}

ensure_command() {
  local cmd="$1"
  local install_fn="$2"
  local display_name="${3:-$cmd}"

  if command_exists "$cmd"; then
    local version
    version=$("$cmd" --version 2>/dev/null | head -1 || echo "installed")
    log SKIP "$display_name already installed: $version"
    SKIPPED+=("$display_name")
  else
    log INFO "Installing $display_name..."
    "$install_fn"
    if command_exists "$cmd"; then
      log OK "$display_name installed successfully"
      INSTALLED+=("$display_name")
    else
      log ERROR "Failed to install $display_name"
      return 1
    fi
  fi
}

retry_curl() {
  local url="$1"
  local max_attempts="${2:-30}"
  local delay="${3:-2}"
  local attempt=1

  while [ "$attempt" -le "$max_attempts" ]; do
    if curl -sf --max-time 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    log INFO "  Waiting for service... (attempt $attempt/$max_attempts)"
    sleep "$delay"
    attempt=$((attempt + 1))
  done
  return 1
}

# Detect package manager: dnf (AL2023/Fedora) or yum fallback
detect_pkg_manager() {
  if command_exists dnf; then
    echo "dnf"
  elif command_exists yum; then
    echo "yum"
  else
    log ERROR "No supported package manager found (need dnf or yum)"
    return 1
  fi
}

# =============================================================================
# Step 1: NVMe Instance Store Setup
# =============================================================================
# m7gd.xlarge has a 237GB NVMe SSD for ephemeral high-speed storage.
# Must run before system dependencies so Docker can use /local/docker as data-root.
# Gracefully skips on instances without instance store (e.g., t4g).
# Handles stop/start cycles (NVMe wiped but fstab entry persists).

step_nvme_setup() {
  log STEP "Step 1/14: NVMe Instance Store Setup"

  # --- 1. Detect NVMe instance store device ---
  # Instance store devices are NVMe but NOT the root EBS volume.
  # Find the root device, then look for other NVMe block devices.
  local root_device
  root_device="$(lsblk -ndo PKNAME "$(findmnt -n -o SOURCE /)" 2>/dev/null || echo "")"

  if [ -z "$root_device" ]; then
    log WARN "Could not determine root device. Skipping NVMe setup."
    WARNINGS+=("NVMe: could not determine root device")
    return 0
  fi

  # Find NVMe devices that are NOT the root device and have no partitions (whole disk)
  local nvme_device=""
  local candidate
  for candidate in /dev/nvme*n1; do
    [ -b "$candidate" ] || continue
    local base_name
    base_name="$(basename "$candidate")"
    # Skip if this is the root device
    if [ "$base_name" = "$root_device" ]; then
      continue
    fi
    # Skip if this device has partitions (likely EBS with partition table)
    if lsblk -n "$candidate" 2>/dev/null | grep -q 'part'; then
      continue
    fi
    # This is our instance store candidate
    nvme_device="$candidate"
    break
  done

  if [ -z "$nvme_device" ]; then
    log SKIP "No NVMe instance store detected (non-d instance type). Skipping."
    SKIPPED+=("NVMe instance store")
    return 0
  fi

  log INFO "Detected NVMe instance store: $nvme_device"

  # --- 2. Check if already mounted ---
  if mountpoint -q /local 2>/dev/null; then
    log SKIP "/local is already mounted"
    SKIPPED+=("NVMe mount")
    # Ensure directory structure exists even if already mounted (idempotent)
    _nvme_create_dirs
    _nvme_configure_docker
    _nvme_create_symlinks
    return 0
  fi

  # --- 3. Format if needed ---
  # NVMe instance store is wiped on stop/start. Check for valid filesystem.
  local fs_type
  fs_type="$(sudo blkid -s TYPE -o value "$nvme_device" 2>/dev/null || echo "")"

  if [ -z "$fs_type" ]; then
    log INFO "No filesystem on $nvme_device. Formatting with ext4..."
    sudo mkfs.ext4 -L nvme-local "$nvme_device"
    log OK "Formatted $nvme_device as ext4 (label: nvme-local)"
    INSTALLED+=("NVMe ext4 filesystem")
  else
    log INFO "Existing filesystem on $nvme_device: $fs_type"
  fi

  # --- 4. Mount ---
  sudo mkdir -p /local
  sudo mount "$nvme_device" /local
  sudo chown "$USER":"$USER" /local
  log OK "Mounted $nvme_device at /local"
  INSTALLED+=("NVMe mount at /local")

  # --- 5. Add fstab entry (idempotent) ---
  if ! grep -q 'LABEL=nvme-local' /etc/fstab; then
    echo 'LABEL=nvme-local /local ext4 defaults,nofail,noatime,discard 0 2' | sudo tee -a /etc/fstab >/dev/null
    log OK "Added /local to /etc/fstab (nofail for graceful degradation)"
    INSTALLED+=("NVMe fstab entry")
  else
    log SKIP "fstab entry for nvme-local already exists"
    SKIPPED+=("NVMe fstab entry")
  fi

  # --- 6-8. Create dirs, configure Docker, create symlinks ---
  _nvme_create_dirs
  _nvme_configure_docker
  _nvme_create_symlinks

  # --- 9. Log summary ---
  local capacity
  capacity="$(df -h /local 2>/dev/null | awk 'NR==2 {print $2}' || echo "unknown")"
  log OK "NVMe setup complete: $nvme_device mounted at /local (${capacity} total)"
}

_nvme_create_dirs() {
  # Create directory structure on NVMe for ephemeral high-speed data
  local dirs=(
    /local/docker
    /local/worktrees
    /local/tmp
    /local/cache/npm
    /local/cache/bun
    /local/cache/steampipe
  )
  for dir in "${dirs[@]}"; do
    mkdir -p "$dir"
  done
  log OK "Created NVMe directory structure (/local/{docker,worktrees,tmp,cache/*})"
}

_nvme_configure_docker() {
  # Configure Docker to use /local/docker as data-root (idempotent)
  local daemon_json="/etc/docker/daemon.json"
  local desired_root="/local/docker"

  if [ -f "$daemon_json" ]; then
    local current_root
    current_root="$(jq -r '."data-root" // empty' "$daemon_json" 2>/dev/null || echo "")"
    if [ "$current_root" = "$desired_root" ]; then
      log SKIP "Docker data-root already set to $desired_root"
      SKIPPED+=("Docker data-root config")
      return 0
    fi
    # Merge data-root into existing config
    local tmp_json
    tmp_json="$(jq --arg root "$desired_root" '. + {"data-root": $root}' "$daemon_json")"
    echo "$tmp_json" | sudo tee "$daemon_json" >/dev/null
    log OK "Updated $daemon_json with data-root: $desired_root"
  else
    sudo mkdir -p "$(dirname "$daemon_json")"
    printf '{\n  "data-root": "%s"\n}\n' "$desired_root" | sudo tee "$daemon_json" >/dev/null
    log OK "Created $daemon_json with data-root: $desired_root"
  fi
  INSTALLED+=("Docker data-root -> /local/docker")

  # If Docker is already running, it needs a restart to pick up the new data-root.
  # Don't restart here — step_system_dependencies handles Docker lifecycle.
  if systemctl is-active --quiet docker 2>/dev/null; then
    log WARN "Docker is running but data-root changed. Docker needs restart to use /local/docker."
    log INFO "  Restart will happen when Docker is next started/restarted."
    WARNINGS+=("Docker: restart needed for new data-root")
  fi
}

_nvme_create_symlinks() {
  # Set TMPDIR for this session and create cache symlinks
  if mountpoint -q /local 2>/dev/null; then
    export TMPDIR=/local/tmp
    log OK "Set TMPDIR=/local/tmp for this session"

    # Symlink ~/.cache/steampipe -> /local/cache/steampipe
    local steampipe_cache="$HOME/.cache/steampipe"
    if [ -L "$steampipe_cache" ]; then
      log SKIP "Steampipe cache symlink already exists"
      SKIPPED+=("Steampipe cache symlink")
    elif [ -d "$steampipe_cache" ]; then
      # Move existing cache data to NVMe, then symlink
      log INFO "Moving existing steampipe cache to /local/cache/steampipe..."
      cp -a "$steampipe_cache/." /local/cache/steampipe/ 2>/dev/null || true
      rm -rf "$steampipe_cache"
      ln -sfn /local/cache/steampipe "$steampipe_cache"
      log OK "Migrated and symlinked steampipe cache to NVMe"
      INSTALLED+=("Steampipe cache -> NVMe")
    else
      mkdir -p "$(dirname "$steampipe_cache")"
      ln -sfn /local/cache/steampipe "$steampipe_cache"
      log OK "Created steampipe cache symlink to NVMe"
      INSTALLED+=("Steampipe cache -> NVMe")
    fi
  fi
}

# =============================================================================
# Step 2: System Dependencies
# =============================================================================

install_docker() {
  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  sudo "$pkg_mgr" install -y docker
  sudo systemctl enable docker
  sudo systemctl start docker
  # Add current user to docker group (takes effect on next login)
  sudo usermod -aG docker "$USER" 2>/dev/null || true
}

install_docker_compose_plugin() {
  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  # Try the plugin package first (AL2023/Fedora)
  if sudo "$pkg_mgr" install -y docker-compose-plugin 2>/dev/null; then
    return 0
  fi
  # Fallback: install standalone binary
  local compose_version
  compose_version="$(curl -fsSL https://api.github.com/repos/docker/compose/releases/latest | jq -r '.tag_name')"
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  sudo curl -fsSL "https://github.com/docker/compose/releases/download/${compose_version}/docker-compose-linux-$(uname -m)" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
}

install_tailscale() {
  curl -fsSL https://tailscale.com/install.sh | sudo bash
  sudo systemctl enable tailscaled
  sudo systemctl start tailscaled
}

install_tmux() {
  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  sudo "$pkg_mgr" install -y tmux
}

install_git() {
  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  sudo "$pkg_mgr" install -y git
}

install_jq() {
  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  sudo "$pkg_mgr" install -y jq
}

install_curl() {
  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  sudo "$pkg_mgr" install -y curl
}

install_wget() {
  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  sudo "$pkg_mgr" install -y wget
}

install_unzip() {
  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  sudo "$pkg_mgr" install -y unzip
}

install_nodejs() {
  # Install Node.js 20 via dnf module or NodeSource
  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"

  if [ "$pkg_mgr" = "dnf" ]; then
    # AL2023 / Fedora: try dnf module first
    if sudo dnf module list nodejs 2>/dev/null | grep -q '20'; then
      sudo dnf module enable -y nodejs:20
      sudo dnf install -y nodejs
    else
      # NodeSource fallback
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
      sudo dnf install -y nodejs
    fi
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo yum install -y nodejs
  fi
}

install_bun() {
  curl -fsSL https://bun.sh/install | bash
  # Source the updated profile so bun is available in this session
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
}

install_claude_code() {
  # Requires npm (from Node.js)
  if ! command_exists npm; then
    log ERROR "npm required for Claude Code CLI but not found"
    return 1
  fi
  sudo npm install -g @anthropic-ai/claude-code
}

install_steampipe() {
  sudo sh -c "$(curl -fsSL https://steampipe.io/install/steampipe.sh)"
}

install_steampipe_aws_plugin() {
  steampipe plugin install aws
}

install_bws() {
  # Bitwarden Secrets Manager CLI (bws) — standalone binary, NOT @bitwarden/cli (that's bw)
  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64) arch="aarch64-unknown-linux-gnu" ;;
    x86_64)  arch="x86_64-unknown-linux-gnu" ;;
    *)       log WARN "Unsupported architecture for bws: $arch"; return 1 ;;
  esac

  # Get latest release tag from GitHub API
  local latest_tag
  latest_tag="$(curl -fsSL https://api.github.com/repos/bitwarden/sdk/releases?per_page=20 \
    | jq -r '[.[] | select(.tag_name | startswith("bws-v"))][0].tag_name // empty')"

  if [ -z "$latest_tag" ]; then
    log WARN "Could not determine latest bws release"
    return 1
  fi

  local version="${latest_tag#bws-v}"
  local url="https://github.com/bitwarden/sdk/releases/download/${latest_tag}/bws-${arch}-${version}.zip"

  log INFO "Downloading bws ${version} for ${arch}..."
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  if curl -fsSL -o "${tmp_dir}/bws.zip" "$url"; then
    unzip -o "${tmp_dir}/bws.zip" -d "${tmp_dir}/"
    sudo install -m 755 "${tmp_dir}/bws" /usr/local/bin/bws
    rm -rf "$tmp_dir"
  else
    rm -rf "$tmp_dir"
    log WARN "Failed to download bws from $url"
    return 1
  fi
}

step_system_dependencies() {
  log STEP "Step 2/14: System Dependencies"

  # Core system packages
  ensure_command "curl"    install_curl    "curl"
  ensure_command "wget"    install_wget    "wget"
  ensure_command "git"     install_git     "git"
  ensure_command "jq"      install_jq      "jq"
  ensure_command "unzip"   install_unzip   "unzip"
  ensure_command "tmux"    install_tmux    "tmux"

  # Docker
  ensure_command "docker"  install_docker  "Docker"

  # Docker Compose plugin: check via 'docker compose version'
  if docker compose version &>/dev/null 2>&1; then
    log SKIP "docker-compose plugin already installed"
    SKIPPED+=("docker-compose-plugin")
  else
    log INFO "Installing docker-compose plugin..."
    install_docker_compose_plugin
    log OK "docker-compose plugin installed"
    INSTALLED+=("docker-compose-plugin")
  fi

  # Tailscale
  ensure_command "tailscale" install_tailscale "Tailscale"

  # Node.js
  ensure_command "node" install_nodejs "Node.js"

  # Bun
  ensure_command "bun" install_bun "Bun"

  # NOTE: Claude Code CLI -> dedicated step 10
  # NOTE: Steampipe + AWS plugin -> dedicated step 9
  # NOTE: Windmill CLI (wmill) -> dedicated step 11
  # NOTE: mcp-tools -> dedicated step 12

  # Bitwarden Secrets CLI (non-critical — secrets sync can be set up later)
  ensure_command "bws" install_bws "Bitwarden Secrets CLI (bws)" || true
}

# =============================================================================
# Step 3: Clone Repos
# =============================================================================

clone_or_pull() {
  local name="$1"
  local url="$2"
  local dest="$REPOS_DIR/$name"

  if [ -d "$dest/.git" ]; then
    log INFO "$name: already cloned, pulling latest..."
    # Use --ff-only to avoid merge commits; tolerate failure (e.g. detached HEAD)
    if git -C "$dest" pull --ff-only 2>/dev/null; then
      log OK "$name: updated"
    else
      log WARN "$name: pull failed (detached HEAD or dirty tree). Skipping update."
      WARNINGS+=("$name: could not auto-update")
    fi
  elif [ -d "$dest" ]; then
    log WARN "$name: directory exists but is not a git repo. Leaving as-is."
    WARNINGS+=("$name: exists but not a git repo")
  else
    log INFO "$name: cloning from $url..."
    if git clone "$url" "$dest"; then
      log OK "$name: cloned"
    else
      log WARN "$name: clone failed (private repo or network issue). Skipping."
      WARNINGS+=("$name: clone failed")
    fi
  fi
}

step_clone_repos() {
  log STEP "Step 3/14: Clone Repositories"

  mkdir -p "$REPOS_DIR"

  clone_or_pull "PAI"      "https://github.com/danielmiessler/PAI.git"
  clone_or_pull "imladris"  "https://github.com/sethdf/imladris.git"
  clone_or_pull "dotfiles" "https://github.com/sethdf/dotfiles.git"
}

# =============================================================================
# Step 4: Create Symlinks (Decision 34)
# =============================================================================

create_symlink() {
  local target="$1"
  local link="$2"
  local name="$3"

  # If the target directory does not exist, warn and skip
  if [ ! -d "$target" ]; then
    log WARN "$name: target $target does not exist. Skipping symlink."
    WARNINGS+=("symlink $name: target missing")
    return 0
  fi

  # Remove existing symlink or empty directory at link path
  if [ -L "$link" ]; then
    rm "$link"
  elif [ -d "$link" ] && [ -z "$(ls -A "$link" 2>/dev/null)" ]; then
    rmdir "$link"
  elif [ -d "$link" ]; then
    log WARN "$name: $link is a non-empty directory. Backing up to ${link}.bak"
    mv "$link" "${link}.bak.$(date +%s)"
    WARNINGS+=("symlink $name: existing dir backed up")
  fi

  ln -sfn "$target" "$link"
  log OK "$name: $link -> $target"
}

step_create_symlinks() {
  log STEP "Step 4/14: Create Symlinks (Decision 34)"

  mkdir -p "$CLAUDE_DIR"

  create_symlink "$REPOS_DIR/PAI/skills" "$CLAUDE_DIR/skills" "skills"
  create_symlink "$REPOS_DIR/PAI/agents" "$CLAUDE_DIR/agents" "agents"
}

# =============================================================================
# Step 5: Create Runtime Directories
# =============================================================================

step_create_runtime_dirs() {
  log STEP "Step 5/14: Create Runtime Directories"

  local dirs=(
    "$CLAUDE_DIR/MEMORY/WORK"
    "$CLAUDE_DIR/MEMORY/STATE"
    "$CLAUDE_DIR/MEMORY/LEARNING/REFLECTIONS"
    "$CLAUDE_DIR/projects"
    "$CLAUDE_DIR/logs"
  )

  for dir in "${dirs[@]}"; do
    if [ -d "$dir" ]; then
      log SKIP "Already exists: $dir"
    else
      mkdir -p "$dir"
      log OK "Created: $dir"
    fi
  done
}

# =============================================================================
# Step 6: Settings Template
# =============================================================================

step_settings_template() {
  log STEP "Step 6/14: Settings Template"

  local target="$CLAUDE_DIR/settings.json"

  if [ -f "$target" ]; then
    log SKIP "settings.json already exists, not overwriting"
    return 0
  fi

  # Search known locations for a template
  local template_candidates=(
    "$REPOS_DIR/PAI/settings.json.template"
    "$REPOS_DIR/imladris/settings.json.template"
    "$SCRIPT_DIR/settings.json.template"
  )

  for candidate in "${template_candidates[@]}"; do
    if [ -f "$candidate" ]; then
      cp "$candidate" "$target"
      log OK "Copied settings template from $candidate"
      return 0
    fi
  done

  log WARN "No settings.json.template found. Create $target manually."
  WARNINGS+=("settings.json: no template found, create manually")
}

# =============================================================================
# Step 7: Bitwarden Secrets Check
# =============================================================================

step_bitwarden_check() {
  log STEP "Step 7/14: Bitwarden Secrets Check"

  if ! command_exists bws; then
    log WARN "bws CLI not installed. Secrets sync unavailable."
    log INFO "Install: https://bitwarden.com/help/secrets-manager-cli/"
    WARNINGS+=("bws: not installed")
    return 0
  fi

  log OK "bws CLI is installed"

  if [ -n "${BWS_ACCESS_TOKEN:-}" ]; then
    log OK "BWS_ACCESS_TOKEN is set. Secrets sync ready."
  else
    log WARN "BWS_ACCESS_TOKEN not set. Set it in your shell profile to enable secret sync."
    WARNINGS+=("BWS_ACCESS_TOKEN: not set")
  fi
}

# =============================================================================
# Step 8: Start Services
# =============================================================================

step_start_services() {
  log STEP "Step 8/14: Start Services (Tailscale + Windmill)"

  # --- Tailscale authentication ---
  if [ -n "${TAILSCALE_AUTH_KEY:-}" ]; then
    if tailscale status &>/dev/null 2>&1; then
      log SKIP "Tailscale already authenticated"
      SKIPPED+=("Tailscale auth")
    else
      log INFO "Authenticating Tailscale..."
      sudo tailscale up --authkey "$TAILSCALE_AUTH_KEY" --hostname imladris --ssh
      log OK "Tailscale authenticated (hostname: imladris)"
      INSTALLED+=("Tailscale auth")
    fi
  else
    log WARN "TAILSCALE_AUTH_KEY not set. Authenticate manually: sudo tailscale up"
    WARNINGS+=("Tailscale: manual auth needed")
  fi

  # --- Windmill (Docker Compose) ---
  local compose_file="$IMLADRIS_DIR/docker-compose.yml"

  if [ ! -f "$compose_file" ]; then
    log WARN "docker-compose.yml not found at $compose_file. Skipping service start."
    WARNINGS+=("Windmill: docker-compose.yml missing")
    return 0
  fi

  if ! command_exists docker; then
    log WARN "Docker not available. Skipping service start."
    WARNINGS+=("Windmill: Docker not available")
    return 0
  fi

  # Check if docker daemon is running
  if ! docker info &>/dev/null 2>&1; then
    log WARN "Docker daemon not running. Attempting to start..."
    sudo systemctl start docker || true
    sleep 2
    if ! docker info &>/dev/null 2>&1; then
      log WARN "Docker daemon failed to start. Skipping services."
      WARNINGS+=("Windmill: Docker daemon not running")
      return 0
    fi
  fi

  # NOTE: If step_nvme_setup configured Docker data-root to /local/docker,
  # Docker should have been restarted before reaching this point.
  # If Docker was freshly installed by step_system_dependencies, it will
  # already start with the correct data-root from /etc/docker/daemon.json.
  # If Docker was pre-existing and data-root changed, a manual restart
  # may be needed: sudo systemctl restart docker

  log INFO "Starting Windmill services..."
  docker compose -f "$compose_file" up -d

  log INFO "Waiting for Windmill healthcheck (http://localhost:8000/api/version)..."
  if retry_curl "http://localhost:8000/api/version" 30 2; then
    local version
    version="$(curl -sf http://localhost:8000/api/version 2>/dev/null || echo "unknown")"
    log OK "Windmill is healthy (version: $version)"
  else
    log WARN "Windmill did not become healthy within 60 seconds."
    log INFO "Check logs: docker compose -f $compose_file logs"
    WARNINGS+=("Windmill: healthcheck timed out")
  fi
}

# =============================================================================
# Step 9: Steampipe + AWS Plugin
# =============================================================================

step_steampipe() {
  log STEP "Step 9/14: Steampipe + AWS Plugin"

  # Install Steampipe binary
  if command_exists steampipe; then
    local version
    version="$(steampipe --version 2>/dev/null | head -1 || echo "installed")"
    log SKIP "Steampipe already installed: $version"
    SKIPPED+=("Steampipe")
  else
    log INFO "Installing Steampipe (latest ARM64)..."
    if sudo sh -c "$(curl -fsSL https://steampipe.io/install/steampipe.sh)"; then
      log OK "Steampipe installed: $(steampipe --version 2>/dev/null | head -1)"
      INSTALLED+=("Steampipe")
    else
      log WARN "Steampipe installation failed"
      WARNINGS+=("Steampipe: installation failed")
      return 0
    fi
  fi

  # Install AWS plugin
  if steampipe plugin list 2>/dev/null | grep -q 'aws'; then
    log SKIP "Steampipe AWS plugin already installed"
    SKIPPED+=("steampipe-aws-plugin")
  else
    log INFO "Installing Steampipe AWS plugin..."
    if steampipe plugin install aws; then
      log OK "Steampipe AWS plugin installed"
      INSTALLED+=("steampipe-aws-plugin")
    else
      log WARN "Steampipe AWS plugin installation failed"
      WARNINGS+=("steampipe-aws-plugin: installation failed")
    fi
  fi
}

# =============================================================================
# Step 10: Claude Code CLI
# =============================================================================

step_claude_code() {
  log STEP "Step 10/14: Claude Code CLI"

  if command_exists claude; then
    local version
    version="$(claude --version 2>/dev/null | head -1 || echo "installed")"
    log SKIP "Claude Code CLI already installed: $version"
    SKIPPED+=("Claude Code CLI")
    return 0
  fi

  if ! command_exists npm; then
    log WARN "npm required for Claude Code CLI but not found. Skipping."
    WARNINGS+=("Claude Code CLI: npm not available")
    return 0
  fi

  log INFO "Installing Claude Code CLI via npm..."
  if sudo npm install -g @anthropic-ai/claude-code; then
    log OK "Claude Code CLI installed: $(claude --version 2>/dev/null | head -1)"
    INSTALLED+=("Claude Code CLI")
  else
    log WARN "Claude Code CLI installation failed"
    WARNINGS+=("Claude Code CLI: installation failed")
  fi
}

# =============================================================================
# Step 11: Windmill CLI (wmill)
# =============================================================================

step_wmill_cli() {
  log STEP "Step 11/14: Windmill CLI (wmill)"

  if command_exists wmill; then
    local version
    version="$(wmill --version 2>/dev/null | head -1 || echo "installed")"
    log SKIP "Windmill CLI already installed: $version"
    SKIPPED+=("Windmill CLI (wmill)")
    return 0
  fi

  if ! command_exists npm; then
    log WARN "npm required for Windmill CLI but not found. Skipping."
    WARNINGS+=("Windmill CLI: npm not available")
    return 0
  fi

  log INFO "Installing Windmill CLI via npm..."
  if sudo npm install -g windmill-client; then
    log OK "Windmill CLI installed: $(wmill --version 2>/dev/null | head -1)"
    INSTALLED+=("Windmill CLI (wmill)")
  else
    log WARN "Windmill CLI installation failed"
    WARNINGS+=("Windmill CLI: installation failed")
  fi
}

# =============================================================================
# Step 12: mcp-tools CLI
# =============================================================================

step_mcp_tools() {
  log STEP "Step 12/14: mcp-tools CLI"

  if command_exists mcp-tools; then
    local version
    version="$(mcp-tools --version 2>/dev/null | head -1 || echo "installed")"
    log SKIP "mcp-tools already installed: $version"
    SKIPPED+=("mcp-tools")
    return 0
  fi

  log INFO "Installing mcp-tools (linux/arm64)..."
  local url="https://github.com/nicholasgasior/mcp-tools/releases/latest/download/mcp-tools-linux-arm64"
  if sudo curl -fsSL -o /usr/local/bin/mcp-tools "$url" && sudo chmod +x /usr/local/bin/mcp-tools; then
    log OK "mcp-tools installed: $(mcp-tools --version 2>/dev/null | head -1 || echo "binary placed")"
    INSTALLED+=("mcp-tools")
  else
    log WARN "mcp-tools installation failed"
    WARNINGS+=("mcp-tools: installation failed")
  fi
}

# =============================================================================
# Step 13: AI Failover Setup
# =============================================================================

step_ai_failover() {
  log STEP "Step 13/14: AI Failover Setup"

  local failover_dir="$IMLADRIS_DIR/ai-failover"
  local wrapper="$failover_dir/claude-failover"

  if [ ! -f "$wrapper" ]; then
    log WARN "Failover wrapper not found at $wrapper"
    WARNINGS+=("ai-failover: wrapper script not found")
    return 0
  fi

  # Ensure wrapper is executable
  chmod +x "$wrapper"
  log OK "Failover wrapper executable"

  # Initialize the env file if it doesn't exist
  local env_file="$CLAUDE_DIR/ai-provider.env"
  if [ ! -f "$env_file" ]; then
    cat > "$env_file" << 'ENVEOF'
# Auto-generated by claude-failover — do not edit manually
# Provider: Anthropic (direct)
ENVEOF
    log OK "Created initial ai-provider.env"
  fi

  # Initialize state file
  local state_file="$CLAUDE_DIR/ai-failover-state"
  if [ ! -f "$state_file" ]; then
    echo "0" > "$state_file"
    log OK "Created initial ai-failover-state"
  fi

  # Add claude wrapper function to .bashrc
  local profile="$HOME/.bashrc"
  if ! grep -qF 'claude-failover' "$profile" 2>/dev/null; then
    cat >> "$profile" << BASHEOF

# Claude AI reactive failover (Anthropic ↔ Bedrock)
# Wraps claude command to detect API failures and auto-switch providers
claude() { $wrapper "\$@"; }
BASHEOF
    log OK "Added claude() wrapper function to .bashrc"
  else
    log SKIP "claude-failover already in .bashrc"
  fi

  # Clean up old systemd units if they exist (migration from timer-based approach)
  local systemd_user_dir="$HOME/.config/systemd/user"
  if [ -f "$systemd_user_dir/claude-ai-failover.timer" ]; then
    systemctl --user disable --now claude-ai-failover.timer 2>/dev/null || true
    rm -f "$systemd_user_dir/claude-ai-failover.service" "$systemd_user_dir/claude-ai-failover.timer"
    systemctl --user daemon-reload 2>/dev/null || true
    log OK "Cleaned up old systemd failover units"
  fi

  INSTALLED+=("AI failover (reactive)")
}

# =============================================================================
# Step 14: Summary
# =============================================================================

step_summary() {
  log STEP "Step 14/14: Bootstrap Summary"

  echo ""
  echo -e "${BOLD}Paths:${NC}"
  if mountpoint -q /local 2>/dev/null; then
    echo "  NVMe:      /local/ ($(df -h /local 2>/dev/null | awk 'NR==2 {print $2}') total, $(df -h /local 2>/dev/null | awk 'NR==2 {print $4}') free)"
  fi
  echo "  Repos:     $REPOS_DIR/"
  echo "  Claude:    $CLAUDE_DIR/"
  echo "  Skills:    $CLAUDE_DIR/skills/ -> $REPOS_DIR/PAI/skills/"
  echo "  Agents:    $CLAUDE_DIR/agents/ -> $REPOS_DIR/PAI/agents/"
  echo "  Memory:    $CLAUDE_DIR/MEMORY/"
  echo "  Projects:  $CLAUDE_DIR/projects/"
  echo "  Logs:      $CLAUDE_DIR/logs/"
  echo "  Imladris:  $IMLADRIS_DIR/"
  echo "  Log file:  $LOG_FILE"

  if [ ${#INSTALLED[@]} -gt 0 ]; then
    echo ""
    echo -e "${GREEN}${BOLD}Installed (${#INSTALLED[@]}):${NC}"
    for item in "${INSTALLED[@]}"; do
      echo -e "  ${GREEN}+${NC} $item"
    done
  fi

  if [ ${#SKIPPED[@]} -gt 0 ]; then
    echo ""
    echo -e "${BLUE}${BOLD}Already present (${#SKIPPED[@]}):${NC}"
    for item in "${SKIPPED[@]}"; do
      echo -e "  ${BLUE}=${NC} $item"
    done
  fi

  if [ ${#WARNINGS[@]} -gt 0 ]; then
    echo ""
    echo -e "${YELLOW}${BOLD}Warnings (${#WARNINGS[@]}):${NC}"
    for item in "${WARNINGS[@]}"; do
      echo -e "  ${YELLOW}!${NC} $item"
    done
  fi

  echo ""
  echo -e "${BOLD}Next steps:${NC}"
  echo "  1. Authenticate Tailscale:  sudo tailscale up"
  echo "  2. Set BWS_ACCESS_TOKEN in ~/.bashrc for Bitwarden Secrets"
  echo "  3. Configure ~/.claude/settings.json if not templated"
  echo "  4. Start a tmux session:    tmux new -s work"
  echo "  5. Launch Claude Code:      claude"
  echo ""

  if [ ${#WARNINGS[@]} -eq 0 ]; then
    echo -e "${GREEN}${BOLD}Bootstrap complete. All systems nominal.${NC}"
  else
    echo -e "${YELLOW}${BOLD}Bootstrap complete with ${#WARNINGS[@]} warning(s). Review above.${NC}"
  fi
}

# =============================================================================
# Main
# =============================================================================

main() {
  echo -e "${BOLD}"
  echo "  _____           _           _      _"
  echo " |_   _|         | |         | |    (_)"
  echo "   | |  _ __ ___ | | __ _  __| |_ __ _ ___"
  echo "   | | | '_ \` _ \\| |/ _\` |/ _\` | '__| / __|"
  echo "  _| |_| | | | | | | (_| | (_| | |  | \\__ \\"
  echo " |_____|_| |_| |_|_|\\__,_|\\__,_|_|  |_|___/"
  echo ""
  echo "  Cloud Workstation Bootstrap v2"
  echo -e "${NC}"
  echo "  Log: $LOG_FILE"
  echo ""

  log INFO "Bootstrap started by $(whoami) on $(hostname)"
  log INFO "OS: $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '"' || echo 'unknown')"

  step_nvme_setup
  step_system_dependencies
  step_clone_repos
  step_create_symlinks
  step_create_runtime_dirs
  step_settings_template
  step_bitwarden_check
  step_start_services
  step_steampipe
  step_claude_code
  step_wmill_cli
  step_mcp_tools
  step_ai_failover
  step_summary

  log INFO "Bootstrap finished"
}

main "$@"
