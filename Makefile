.PHONY: init plan apply destroy unlock lock commit-state backup-keys

# Decrypt secrets before running terraform
SECRETS_FILE := secrets.yaml
TFVARS_FILE := terraform.tfvars

# Default target
help:
	@echo "Usage:"
	@echo "  make init      - Initialize terraform and git-crypt"
	@echo "  make plan      - Run terraform plan"
	@echo "  make apply     - Run terraform apply and commit state"
	@echo "  make destroy   - Run terraform destroy and commit state"
	@echo "  make unlock    - Decrypt repo (after fresh clone)"
	@echo "  make lock      - Re-encrypt repo"
	@echo "  make backup-keys - Export encryption keys for backup"
	@echo ""
	@echo "First-time setup:"
	@echo "  make setup     - Initialize git-crypt, sops, and terraform"

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

# Restore from backup (on new machine)
restore-keys:
	@echo "To restore:"
	@echo "1. Save git-crypt key (base64) to a file, then:"
	@echo "   base64 -d keyfile.b64 > /tmp/git-crypt-key"
	@echo "   git-crypt unlock /tmp/git-crypt-key"
	@echo "   rm /tmp/git-crypt-key"
	@echo ""
	@echo "2. Save age key to ~/.config/sops/age/keys.txt"
