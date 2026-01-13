.PHONY: init plan apply destroy unlock lock commit-state backup-keys backup-gitcrypt-to-bws cost ssh-config lint test test-shell test-all validate check test-docker-build test-docker-shell test-docker-terraform test-docker-integration test-docker test-docker-dev test-docker-clean

# Decrypt secrets before running terraform
SECRETS_FILE := secrets.yaml
TFVARS_FILE := terraform.tfvars

AWS_REGION := us-east-1

# Default target
help:
	@echo "Usage:"
	@echo "  make init        - Initialize terraform and git-crypt"
	@echo "  make plan        - Run terraform plan"
	@echo "  make apply       - Run terraform apply and commit state"
	@echo "  make destroy     - Run terraform destroy and commit state"
	@echo "  make unlock      - Decrypt repo (after fresh clone)"
	@echo "  make lock        - Re-encrypt repo"
	@echo "  make backup-keys - Export encryption keys for backup"
	@echo "  make backup-gitcrypt-to-bws - Backup git-crypt key to Bitwarden Secrets Manager"
	@echo "  make cost        - Show current month's AWS cost"
	@echo "  make ssh-config  - Generate SSH config for local machine"
	@echo ""
	@echo "Testing:"
	@echo "  make validate    - Validate terraform and lint scripts"
	@echo "  make lint        - Run all linters (shellcheck, tfsec, pylint)"
	@echo "  make test        - Run Python unit tests"
	@echo "  make test-shell  - Run shell tests (bats)"
	@echo "  make test-all    - Run all tests (Python + shell)"
	@echo "  make check       - Run all checks (lint + test)"
	@echo ""
	@echo "First-time setup:"
	@echo "  make setup       - Initialize git-crypt, sops, and terraform"

# First-time setup
setup: check-deps
	@echo "=== Setting up encryption ==="
	@if [ ! -f .git-crypt/keys/default ]; then \
		echo "Initializing git-crypt..."; \
		git-crypt init; \
	fi
	@if [ ! -f ~/.config/sops/age/keys.txt ]; then \
		echo "Generating age key for sops..."; \
		mkdir -p ~/.config/sops/age; \
		age-keygen -o ~/.config/sops/age/keys.txt 2>&1 | tee /dev/stderr | grep "public key" | awk '{print $$3}' > .sops-age-recipient; \
	else \
		echo "Age key exists, extracting public key..."; \
		grep "public key" ~/.config/sops/age/keys.txt | awk '{print $$4}' > .sops-age-recipient; \
	fi
	@echo "=== Creating .sops.yaml ==="
	@echo "creation_rules:" > .sops.yaml
	@echo "  - path_regex: secrets\\.yaml$$" >> .sops.yaml
	@echo "    age: $$(cat .sops-age-recipient)" >> .sops.yaml
	@echo "=== Creating secrets file ==="
	@if [ ! -f $(SECRETS_FILE) ]; then \
		echo "# Edit this file with: sops secrets.yaml" > secrets.yaml.tmp; \
		echo "tailscale_auth_key: \"tskey-auth-REPLACE-ME\"" >> secrets.yaml.tmp; \
		echo "" >> secrets.yaml.tmp; \
		echo "# Claude Sessions Framework secrets" >> secrets.yaml.tmp; \
		echo "# Get git-crypt key: cd ~/.config/claude-sessions && git-crypt export-key /dev/stdout | base64 -w0" >> secrets.yaml.tmp; \
		echo "git_crypt_key_b64: \"\"" >> secrets.yaml.tmp; \
		echo "" >> secrets.yaml.tmp; \
		echo "# GitHub SSH keys (base64 -w0 < ~/.ssh/id_ed25519_home)" >> secrets.yaml.tmp; \
		echo "github_ssh_key_home_b64: \"\"" >> secrets.yaml.tmp; \
		echo "github_ssh_key_work_b64: \"\"" >> secrets.yaml.tmp; \
		echo "" >> secrets.yaml.tmp; \
		echo "# GitHub token: https://github.com/settings/tokens (needs repo, read:org scopes)" >> secrets.yaml.tmp; \
		echo "github_token: \"\"" >> secrets.yaml.tmp; \
		sops -e secrets.yaml.tmp > $(SECRETS_FILE); \
		rm secrets.yaml.tmp; \
		echo "Created encrypted secrets.yaml - edit with: sops secrets.yaml"; \
	fi
	@echo "=== Initializing Terraform ==="
	terraform init
	@echo ""
	@echo "=== Setup complete ==="
	@echo "Next steps:"
	@echo "  1. Run: sops secrets.yaml"
	@echo "  2. Replace the Tailscale auth key"
	@echo "  3. Run: make backup-keys (save output to password manager)"
	@echo "  4. Run: make apply"

check-deps:
	@command -v git-crypt >/dev/null 2>&1 || { echo "Error: git-crypt not installed. Run: brew install git-crypt"; exit 1; }
	@command -v sops >/dev/null 2>&1 || { echo "Error: sops not installed. Run: brew install sops"; exit 1; }
	@command -v age >/dev/null 2>&1 || { echo "Error: age not installed. Run: brew install age"; exit 1; }
	@command -v terraform >/dev/null 2>&1 || { echo "Error: terraform not installed"; exit 1; }

# Initialize terraform
init:
	terraform init

# Plan changes
plan: decrypt-secrets
	terraform plan

# Apply changes and commit state
apply: decrypt-secrets
	terraform apply
	@$(MAKE) commit-state

# Destroy infrastructure and commit state
destroy: decrypt-secrets
	terraform destroy
	@$(MAKE) commit-state

# Commit state file if changed
commit-state:
	@if git diff --quiet terraform.tfstate 2>/dev/null && git diff --quiet terraform.tfstate.backup 2>/dev/null; then \
		echo "No state changes to commit"; \
	else \
		git add terraform.tfstate terraform.tfstate.backup 2>/dev/null || true; \
		git commit -m "Update terraform state [skip ci]" || echo "Nothing to commit"; \
		echo "State committed. Don't forget to push!"; \
	fi

# Decrypt repo after fresh clone
unlock:
	git-crypt unlock

# Re-encrypt (mainly for testing)
lock:
	git-crypt lock

# Decrypt secrets.yaml to terraform.tfvars format
decrypt-secrets:
	@if [ -f $(SECRETS_FILE) ]; then \
		echo "tailscale_auth_key = \"$$(sops -d --extract '[\"tailscale_auth_key\"]' $(SECRETS_FILE))\"" > .secrets.auto.tfvars; \
		echo "git_crypt_key_b64 = \"$$(sops -d --extract '[\"git_crypt_key_b64\"]' $(SECRETS_FILE) 2>/dev/null || echo '')\"" >> .secrets.auto.tfvars; \
		echo "github_ssh_key_home_b64 = \"$$(sops -d --extract '[\"github_ssh_key_home_b64\"]' $(SECRETS_FILE) 2>/dev/null || echo '')\"" >> .secrets.auto.tfvars; \
		echo "github_ssh_key_work_b64 = \"$$(sops -d --extract '[\"github_ssh_key_work_b64\"]' $(SECRETS_FILE) 2>/dev/null || echo '')\"" >> .secrets.auto.tfvars; \
		echo "github_token = \"$$(sops -d --extract '[\"github_token\"]' $(SECRETS_FILE) 2>/dev/null || echo '')\"" >> .secrets.auto.tfvars; \
	fi

# Export keys for backup (SAVE THIS OUTPUT!)
backup-keys:
	@echo "=============================================="
	@echo "BACKUP THESE KEYS TO YOUR PASSWORD MANAGER"
	@echo "=============================================="
	@echo ""
	@echo "=== Git-crypt key (base64) ==="
	@git-crypt export-key /dev/stdout | base64
	@echo ""
	@echo "=== Age private key (for sops) ==="
	@cat ~/.config/sops/age/keys.txt
	@echo ""
	@echo "=============================================="
	@echo "Store both keys securely. You need them to"
	@echo "recover this repo on a new machine."
	@echo "=============================================="

# Backup git-crypt key to Bitwarden Secrets Manager
backup-gitcrypt-to-bws:
	@command -v bws >/dev/null 2>&1 || { echo "Error: bws not installed. Download from: https://github.com/bitwarden/sdk-sm/releases"; exit 1; }
	@if [ -z "$$BWS_ACCESS_TOKEN" ]; then \
		echo "Error: BWS_ACCESS_TOKEN not set"; \
		echo "Set it with: export BWS_ACCESS_TOKEN='your-token'"; \
		exit 1; \
	fi
	@echo "=== Backing up git-crypt key to Bitwarden Secrets Manager ==="
	@GC_KEY_B64=$$(git-crypt export-key /dev/stdout | base64 -w0); \
	EXISTING=$$(bws secret list 2>/dev/null | jq -r '.[] | select(.key == "git-crypt-key") | .id'); \
	if [ -n "$$EXISTING" ]; then \
		echo "Updating existing git-crypt-key secret..."; \
		bws secret edit "$$EXISTING" --value "$$GC_KEY_B64" >/dev/null && echo "✓ git-crypt-key updated"; \
	else \
		echo "Creating new git-crypt-key secret..."; \
		echo "Note: You need to specify a project ID. Run: bws project list"; \
		read -p "Enter project ID: " PROJECT_ID; \
		bws secret create git-crypt-key "$$GC_KEY_B64" "$$PROJECT_ID" >/dev/null && echo "✓ git-crypt-key created"; \
	fi
	@echo ""
	@echo "Key backed up successfully. To restore on another machine:"
	@echo "  bws secret get <secret-id> | jq -r '.value' | base64 -d > /tmp/gc-key"
	@echo "  git-crypt unlock /tmp/gc-key && rm /tmp/gc-key"

# Restore from backup (on new machine)
restore-keys:
	@echo "To restore:"
	@echo "1. Save git-crypt key (base64) to a file, then:"
	@echo "   base64 -d keyfile.b64 > /tmp/git-crypt-key"
	@echo "   git-crypt unlock /tmp/git-crypt-key"
	@echo "   rm /tmp/git-crypt-key"
	@echo ""
	@echo "2. Save age key to ~/.config/sops/age/keys.txt"

# Show current month's AWS cost for this devbox
cost:
	@echo "=== DevBox Cost (Current Month) ==="
	@START_DATE=$$(date -u +%Y-%m-01); \
	END_DATE=$$(date -u +%Y-%m-%d); \
	aws ce get-cost-and-usage \
		--time-period Start=$$START_DATE,End=$$END_DATE \
		--granularity MONTHLY \
		--metrics "UnblendedCost" \
		--filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Elastic Compute Cloud - Compute","EC2 - Other"]}}' \
		--query 'ResultsByTime[0].Total.UnblendedCost.{Amount:Amount,Unit:Unit}' \
		--output table 2>/dev/null || echo "Note: Requires ce:GetCostAndUsage permission"
	@echo ""
	@echo "For detailed breakdown: AWS Console > Cost Explorer"

# Generate SSH config entry for local machine
ssh-config:
	@echo "=== Add this to your local ~/.ssh/config ==="
	@echo ""
	@INSTANCE_IP=$$(terraform output -raw instance_id 2>/dev/null || echo ""); \
	TAILSCALE_NAME=$$(grep 'tailscale_hostname' terraform.tfvars 2>/dev/null | cut -d'"' -f2 || echo "devbox"); \
	echo "Host devbox"; \
	echo "    HostName $$TAILSCALE_NAME"; \
	echo "    User ubuntu"; \
	echo "    ForwardAgent yes"; \
	echo "    StrictHostKeyChecking no"; \
	echo "    UserKnownHostsFile /dev/null"; \
	echo ""; \
	echo "# Then connect with: ssh devbox"

# =============================================================================
# TESTING & VALIDATION
# =============================================================================

# Quick validation (no external tools required)
validate:
	@echo "=== Terraform Validation ==="
	terraform fmt -check -recursive || { echo "Run 'terraform fmt' to fix formatting"; exit 1; }
	terraform validate
	@echo ""
	@echo "=== Bash Syntax Check ==="
	@for f in scripts/*.sh; do \
		bash -n "$$f" && echo "  ✓ $$f" || exit 1; \
	done
	@echo ""
	@echo "✓ All validations passed"

# Full lint (requires shellcheck, tfsec, pylint)
lint: validate
	@echo ""
	@echo "=== ShellCheck ==="
	@if command -v shellcheck >/dev/null 2>&1; then \
		shellcheck scripts/*.sh && echo "  ✓ All scripts passed"; \
	else \
		echo "  ⚠ shellcheck not installed (brew install shellcheck)"; \
	fi
	@echo ""
	@echo "=== tfsec (Terraform Security) ==="
	@if command -v tfsec >/dev/null 2>&1; then \
		tfsec . --minimum-severity MEDIUM || true; \
	else \
		echo "  ⚠ tfsec not installed (brew install tfsec)"; \
	fi
	@echo ""
	@echo "=== Python Lint ==="
	@if command -v pylint >/dev/null 2>&1; then \
		pylint scripts/*.py --disable=C0114,C0115,C0116 || true; \
	else \
		echo "  ⚠ pylint not installed (pip install pylint)"; \
	fi

# Run Python unit tests
test:
	@echo "=== Running Python Unit Tests ==="
	@if [ -d tests ] && command -v pytest >/dev/null 2>&1; then \
		cd tests && pip install -q -r requirements.txt 2>/dev/null; \
		pytest unit/ -v --tb=short; \
	else \
		echo "pytest not installed. Run: pip install pytest"; \
		exit 1; \
	fi

# Run shell tests (bats)
test-shell:
	@echo "=== Running Shell Tests ==="
	@if command -v bats >/dev/null 2>&1; then \
		bats tests/shell/*.bats; \
	else \
		echo "bats not installed."; \
		echo "  Ubuntu: sudo apt-get install bats"; \
		echo "  macOS:  brew install bats-core"; \
		echo "  Nix:    nix-env -iA nixpkgs.bats"; \
		exit 1; \
	fi

# Run all tests (Python + shell)
test-all: test test-shell
	@echo ""
	@echo "✓ All tests passed"

# Run all checks (lint + test)
check: lint test
	@echo ""
	@echo "✓ All checks passed"

# =============================================================================
# DOCKER-BASED TESTING
# =============================================================================

# Build test container
test-docker-build:
	@echo "=== Building test container ==="
	cd tests/docker && docker compose build

# Run shell tests in Docker (isolated Ubuntu environment)
test-docker-shell: test-docker-build
	@echo "=== Running Shell Tests (Docker) ==="
	cd tests/docker && docker compose --profile shell run --rm test-shell

# Run Terraform validation in Docker
test-docker-terraform: test-docker-build
	@echo "=== Running Terraform Tests (Docker) ==="
	cd tests/docker && docker compose --profile terraform run --rm test-terraform

# Run integration tests in Docker
test-docker-integration: test-docker-build
	@echo "=== Running Integration Tests (Docker) ==="
	cd tests/docker && docker compose --profile integration run --rm test-integration

# Run all Docker tests
test-docker: test-docker-build
	@echo "=== Running All Docker Tests ==="
	cd tests/docker && docker compose --profile all up --abort-on-container-exit

# Interactive Docker shell for debugging
test-docker-dev: test-docker-build
	@echo "=== Starting interactive test shell ==="
	cd tests/docker && docker compose --profile dev run --rm dev

# Clean up Docker test resources
test-docker-clean:
	@echo "=== Cleaning Docker test resources ==="
	cd tests/docker && docker compose down -v --remove-orphans
