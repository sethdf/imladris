#!/usr/bin/env bash
set -uo pipefail

# =============================================================================
# Imladris Pre-Deploy Validation
# =============================================================================
# Runs all checks that would catch the failure modes we've hit in production.
# Run this BEFORE every deploy. Exit 0 = safe to deploy, Exit 1 = fix issues.
#
# Usage: ./tests/validate-deploy.sh
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CF_TEMPLATE="$REPO_DIR/cloudformation/imladris-stack.yaml"
BOOTSTRAP="$REPO_DIR/bootstrap.sh"

PASS=0
FAIL=0
WARN=0

pass() { echo -e "\033[0;32m  PASS\033[0m  $1"; PASS=$((PASS + 1)); }
fail() { echo -e "\033[0;31m  FAIL\033[0m  $1"; FAIL=$((FAIL + 1)); }
warn() { echo -e "\033[1;33m  WARN\033[0m  $1"; WARN=$((WARN + 1)); }
header() { echo -e "\n\033[1m=== $1 ===\033[0m"; }

# =============================================================================
# C1: CloudFormation template passes cfn-lint
# =============================================================================
header "C1: cfn-lint validation"

CFNLINT=""
if command -v cfn-lint &>/dev/null; then
  CFNLINT="cfn-lint"
elif [ -x /tmp/cfnlint-venv/bin/cfn-lint ]; then
  CFNLINT="/tmp/cfnlint-venv/bin/cfn-lint"
fi

if [ -n "$CFNLINT" ]; then
  cfn_output=$($CFNLINT "$CF_TEMPLATE" 2>&1)
  cfn_exit=$?
  if [ $cfn_exit -eq 0 ]; then
    pass "cfn-lint: zero errors"
  else
    # Check if only warnings (W) vs errors (E)
    if echo "$cfn_output" | grep -q '^E'; then
      fail "cfn-lint: errors found"
      echo "$cfn_output" | grep '^E' | head -5
    else
      pass "cfn-lint: no errors (warnings only)"
      echo "$cfn_output" | head -3
    fi
  fi
else
  warn "cfn-lint not found. Install: python3 -m venv /tmp/cfnlint-venv && /tmp/cfnlint-venv/bin/pip install cfn-lint"
fi

# =============================================================================
# C2: Every bootstrap step survives set -e
# Checks that step functions don't have bare commands that can exit non-zero.
# =============================================================================
header "C2: set -e safety audit"

# Extract all function calls from main() that are step_* functions
step_functions=$(grep -oP 'step_\w+' "$BOOTSTRAP" | sort -u)

# Check each step function for dangerous patterns:
# 1. Bare git clone (not in if)
# 2. Bare curl | ... (not in if)
# 3. Bare npm install (not in if)
c2_issues=0

# Check clone_or_pull specifically — the function that caused the dotfiles crash
if grep -A2 'git clone' "$BOOTSTRAP" | grep -v '^\s*#' | grep -v 'if git clone' | grep -q 'git clone'; then
  # There's a git clone not wrapped in if — but check if it's in the install functions (called by ensure_command which has its own error handling)
  # Only flag ones in step_* or clone_or_pull
  bare_clones=$(grep -n 'git clone' "$BOOTSTRAP" | grep -v '^\s*#' | grep -v 'if git clone')
  if [ -n "$bare_clones" ]; then
    fail "C2: bare 'git clone' found (not wrapped in if/else)"
    echo "  $bare_clones"
    c2_issues=$((c2_issues + 1))
  fi
else
  : # no bare git clone
fi

# Check that all git clone calls are wrapped in if
clone_lines=$(grep -n 'git clone' "$BOOTSTRAP" | grep -v '^\s*#')
bare_clone_count=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  lineno=$(echo "$line" | cut -d: -f1)
  # Check if the previous non-blank line starts with 'if'
  prev_line=$(sed -n "$((lineno-1))p" "$BOOTSTRAP" | sed 's/^[[:space:]]*//')
  if [[ ! "$line" =~ "if git clone" ]] && [[ ! "$prev_line" =~ ^if ]]; then
    bare_clone_count=$((bare_clone_count + 1))
  fi
done <<< "$clone_lines"

if [ "$bare_clone_count" -eq 0 ]; then
  pass "All git clone calls are wrapped in if/else"
else
  fail "Found $bare_clone_count bare git clone calls"
fi

# Check docker compose up -d is not bare
if grep -q 'docker compose.*up -d' "$BOOTSTRAP"; then
  # docker compose is called in step_start_services which has earlier guards
  # (checks for docker, checks daemon running) so a late failure is acceptable
  # But verify the function has error guards before the compose call
  if grep -B20 'docker compose.*up -d' "$BOOTSTRAP" | grep -q 'if.*docker info'; then
    pass "docker compose up has pre-flight checks"
  else
    warn "docker compose up may not have adequate error guards"
  fi
fi

# =============================================================================
# C3: All external URLs are reachable
# =============================================================================
header "C3: External URL reachability"

# Extract URLs from bootstrap.sh
urls=(
  "https://github.com/sethdf/imladris.git"
  "https://github.com/danielmiessler/PAI.git"
  "https://api.github.com/repos/docker/compose/releases/latest"
  "https://api.github.com/repos/bitwarden/sdk/releases?per_page=20"
  "https://tailscale.com/install.sh"
  "https://rpm.nodesource.com/setup_20.x"
  "https://bun.sh/install"
  "https://steampipe.io/install/steampipe.sh"
)

for url in "${urls[@]}"; do
  http_code=$(curl -fsSL -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo "000")
  if [ "$http_code" = "200" ] || [ "$http_code" = "302" ] || [ "$http_code" = "301" ]; then
    pass "URL reachable ($http_code): ${url:0:70}"
  else
    fail "URL unreachable ($http_code): $url"
  fi
done

# Special check: bws release asset exists for aarch64
bws_tag=$(curl -fsSL "https://api.github.com/repos/bitwarden/sdk/releases?per_page=20" 2>/dev/null \
  | python3 -c "import json,sys; data=json.load(sys.stdin); tags=[r['tag_name'] for r in data if r['tag_name'].startswith('bws-v')]; print(tags[0] if tags else '')" 2>/dev/null)
if [ -n "$bws_tag" ]; then
  bws_ver="${bws_tag#bws-v}"
  bws_url="https://github.com/bitwarden/sdk/releases/download/${bws_tag}/bws-aarch64-unknown-linux-gnu-${bws_ver}.zip"
  bws_code=$(curl -fsSL -o /dev/null -w '%{http_code}' --max-time 10 -L "$bws_url" 2>/dev/null || echo "000")
  if [ "$bws_code" = "200" ]; then
    pass "bws ARM64 binary exists: $bws_tag"
  else
    fail "bws ARM64 binary missing ($bws_code): $bws_url"
  fi
else
  fail "Could not find bws release tag"
fi

# Check mcp-tools URL
mcp_url="https://github.com/nicholasgasior/mcp-tools/releases/latest/download/mcp-tools-linux-arm64"
mcp_code=$(curl -fsSL -o /dev/null -w '%{http_code}' --max-time 10 -L "$mcp_url" 2>/dev/null || echo "000")
if [ "$mcp_code" = "200" ]; then
  pass "mcp-tools ARM64 binary reachable"
else
  warn "mcp-tools ARM64 binary unreachable ($mcp_code) — non-critical"
fi

# =============================================================================
# C4: Docker compose plugin mkdir ordering
# =============================================================================
header "C4: Docker compose install ordering"

mkdir_line=$(grep -n 'mkdir -p /usr/local/lib/docker/cli-plugins' "$BOOTSTRAP" | head -1 | cut -d: -f1)
curl_compose_line=$(grep -n 'curl.*docker-compose-linux' "$BOOTSTRAP" | head -1 | cut -d: -f1)

if [ -n "$mkdir_line" ] && [ -n "$curl_compose_line" ]; then
  if [ "$mkdir_line" -lt "$curl_compose_line" ]; then
    pass "mkdir -p comes BEFORE curl download (line $mkdir_line < $curl_compose_line)"
  else
    fail "mkdir -p comes AFTER curl download (line $mkdir_line > $curl_compose_line) — will fail!"
  fi
else
  fail "Could not find mkdir or curl lines for docker-compose install"
fi

# =============================================================================
# C5: bws uses correct repo
# =============================================================================
header "C5: bws install repo URL"

if grep -q 'bitwarden/sdk/releases' "$BOOTSTRAP"; then
  pass "bws install uses bitwarden/sdk (correct)"
else
  fail "bws install does not reference bitwarden/sdk"
fi

if grep -q 'bitwarden/sdk-internal' "$BOOTSTRAP"; then
  fail "bws install still references bitwarden/sdk-internal (wrong repo!)"
else
  pass "No reference to bitwarden/sdk-internal"
fi

# =============================================================================
# C6: Private repo clone doesn't crash
# =============================================================================
header "C6: git clone error handling"

# The clone_or_pull function must wrap git clone in if/else
if grep -A3 'clone_or_pull.*dotfiles' "$BOOTSTRAP" | grep -q 'sethdf/dotfiles'; then
  pass "dotfiles repo is in the clone list"
fi

# Check clone_or_pull wraps git clone in if
if grep -A5 'cloning from' "$BOOTSTRAP" | grep -q 'if git clone'; then
  pass "git clone is wrapped in if/else (handles auth failures)"
else
  fail "git clone is NOT wrapped — private repos will crash bootstrap"
fi

# =============================================================================
# C7: bws install is non-fatal
# =============================================================================
header "C7: bws install || true"

if grep -q 'ensure_command "bws".*|| true' "$BOOTSTRAP"; then
  pass "bws ensure_command has || true"
else
  fail "bws ensure_command missing || true — failure will crash bootstrap"
fi

# =============================================================================
# C8: Instance store device name
# =============================================================================
header "C8: Instance store device name in CF"

if grep -q 'DeviceName: /dev/sdb' "$CF_TEMPLATE"; then
  pass "Instance store uses /dev/sdb (CloudFormation-compatible)"
else
  fail "Instance store does not use /dev/sdb"
fi

if grep -q 'DeviceName: /dev/nvme' "$CF_TEMPLATE"; then
  fail "CF template still has /dev/nvme* device name — CF requires /dev/sd*"
else
  pass "No /dev/nvme* device names in CF template"
fi

# =============================================================================
# C9: Bucket policy includes admin ARN
# =============================================================================
header "C9: S3 bucket policy admin access"

if grep -q 'AdminPrincipalArn' "$CF_TEMPLATE" && grep -A20 'ArnNotLike' "$CF_TEMPLATE" | grep -q 'AdminPrincipalArn'; then
  pass "AdminPrincipalArn in bucket policy ArnNotLike allow list"
else
  fail "AdminPrincipalArn NOT in bucket policy — rollback will lock out CF"
fi

# =============================================================================
# C10: Git clone URL in UserData
# =============================================================================
header "C10: UserData git clone URL"

userdata_url=$(grep 'git clone.*imladris' "$CF_TEMPLATE" | grep -oP 'https://[^ ]+' | head -1)
if [ "$userdata_url" = "https://github.com/sethdf/imladris.git" ]; then
  pass "UserData git clone URL is correct: $userdata_url"
else
  fail "UserData git clone URL is wrong: $userdata_url (expected sethdf/imladris.git)"
fi

# Verify it's actually reachable
clone_check=$(curl -fsSL -o /dev/null -w '%{http_code}' --max-time 10 "https://github.com/sethdf/imladris" 2>/dev/null || echo "000")
if [ "$clone_check" = "200" ]; then
  pass "sethdf/imladris repo is publicly accessible"
else
  fail "sethdf/imladris repo not accessible ($clone_check) — clone will fail"
fi

# =============================================================================
# C11: sudo --preserve-env
# =============================================================================
header "C11: Environment variable passthrough"

if grep -q '\-\-preserve-env=BWS_TOKEN,TAILSCALE_AUTH_KEY' "$CF_TEMPLATE"; then
  pass "sudo --preserve-env passes BWS_TOKEN and TAILSCALE_AUTH_KEY"
else
  fail "sudo --preserve-env not found or missing variables"
fi

# =============================================================================
# C12: cfn-signal trap
# =============================================================================
header "C12: cfn-signal EXIT trap"

if grep -q "trap.*cfn-signal.*EXIT" "$CF_TEMPLATE"; then
  pass "cfn-signal EXIT trap is present in UserData"
else
  fail "cfn-signal EXIT trap is MISSING — CF will timeout waiting for signal"
fi

# Verify trap uses $? (captures actual exit code)
if grep -q 'cfn-signal -e \$?' "$CF_TEMPLATE"; then
  pass "cfn-signal uses \$? to report actual exit code"
else
  fail "cfn-signal may not report actual exit code"
fi

# =============================================================================
# C15: UserData has connectivity wait and git clone retry
# =============================================================================
header "C15: UserData resilience (connectivity + clone retry)"

if grep -q 'Waiting for internet' "$CF_TEMPLATE"; then
  pass "UserData waits for internet connectivity before clone"
else
  fail "UserData has no internet connectivity check — clone may timeout"
fi

if grep -q 'git clone failed.*retrying' "$CF_TEMPLATE" || grep -B2 'git clone.*imladris' "$CF_TEMPLATE" | grep -q 'for.*seq'; then
  pass "UserData git clone has retry logic"
else
  fail "UserData git clone has no retry — transient failures will crash deploy"
fi

# =============================================================================
# C13: shellcheck
# =============================================================================
header "C13: shellcheck"

SHELLCHECK=""
if command -v shellcheck &>/dev/null; then
  SHELLCHECK="shellcheck"
elif [ -x /tmp/shellcheck ]; then
  SHELLCHECK="/tmp/shellcheck"
fi

if [ -n "$SHELLCHECK" ]; then
  sc_output=$($SHELLCHECK -S error "$BOOTSTRAP" 2>&1)
  sc_exit=$?
  if [ $sc_exit -eq 0 ]; then
    pass "shellcheck: zero errors"
  else
    fail "shellcheck: errors found"
    echo "$sc_output" | head -20
  fi

  # Also check warnings (informational)
  sc_warn=$($SHELLCHECK -S warning "$BOOTSTRAP" 2>&1)
  sc_warn_count=$(echo "$sc_warn" | grep -c "^In " 2>/dev/null || echo 0)
  if [ "$sc_warn_count" -gt 0 ]; then
    warn "shellcheck: $sc_warn_count warnings (non-blocking)"
  fi
else
  warn "shellcheck not found. Install for full validation."
fi

# =============================================================================
# A1: No unprotected commands that can crash bootstrap
# =============================================================================
header "A1: Unprotected command scan"

# Scan for dangerous patterns OUTSIDE of if/else blocks and install_ functions
# The install_ functions are always called by ensure_command which has its own error handling
# So we only care about commands in step_* functions and main()

a1_issues=0

# Check: any bare 'curl -fsSL ... | sudo bash' not in if/else
# These are OK inside install_* functions (called by ensure_command)
# Pattern: look for pipe-to-bash in step_* functions
while IFS= read -r line; do
  [ -z "$line" ] && continue
  lineno=$(echo "$line" | cut -d: -f1)
  # Check which function this is in
  func=$(awk -v ln="$lineno" 'NR<=ln && /^[a-z_]+\(\)/ {f=$0} NR==ln {print f}' "$BOOTSTRAP")
  if [[ "$func" =~ ^step_ ]]; then
    fail "A1: bare curl|bash in step function at line $lineno"
    a1_issues=$((a1_issues + 1))
  fi
done < <(grep -n 'curl.*|.*bash' "$BOOTSTRAP" | grep -v '^\s*#' | grep -v '^[[:space:]]*if ')

# Check: docker compose up without error handling
compose_line=$(grep -n 'docker compose.*up -d' "$BOOTSTRAP" | head -1)
if [ -n "$compose_line" ]; then
  lineno=$(echo "$compose_line" | cut -d: -f1)
  prev=$(sed -n "$((lineno-1))p" "$BOOTSTRAP" | sed 's/^[[:space:]]*//')
  if [[ ! "$prev" =~ ^if ]] && [[ ! "$compose_line" =~ "if docker" ]]; then
    # docker compose up -d can fail but subsequent retry_curl handles the fallout
    # Still flag as a potential issue
    warn "A1: docker compose up -d at line $lineno not in if/else (mitigated by retry_curl)"
  fi
fi

if [ "$a1_issues" -eq 0 ]; then
  pass "No dangerous unprotected commands in step functions"
fi

# =============================================================================
# A2: No hardcoded secrets
# =============================================================================
header "A2: Secret scan"

# Scan all committed files for common secret patterns
secret_patterns=(
  'tskey-auth-'
  'AKIA[0-9A-Z]{16}'
  'aws_secret_access_key'
  'password\s*[:=]'
  '0\.[0-9a-f]{8}-'
)

a2_found=0
for pattern in "${secret_patterns[@]}"; do
  matches=$(grep -rn "$pattern" "$REPO_DIR" --include='*.sh' --include='*.yaml' --include='*.yml' --include='*.json' --include='*.ts' --include='*.template' 2>/dev/null | grep -v 'tests/validate-deploy.sh' | grep -v '.git/' || true)
  if [ -n "$matches" ]; then
    fail "A2: Secret pattern '$pattern' found in committed files:"
    echo "$matches" | head -3
    a2_found=$((a2_found + 1))
  fi
done

if [ "$a2_found" -eq 0 ]; then
  pass "No hardcoded secrets found in committed files"
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "\033[1m  Results: \033[0;32m$PASS passed\033[0m, \033[0;31m$FAIL failed\033[0m, \033[1;33m$WARN warnings\033[0m"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -gt 0 ]; then
  echo -e "\n\033[0;31m  ✗ NOT SAFE TO DEPLOY — fix $FAIL failure(s) first\033[0m"
  exit 1
else
  echo -e "\n\033[0;32m  ✓ SAFE TO DEPLOY — all critical checks passed\033[0m"
  exit 0
fi
