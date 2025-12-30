.PHONY: init plan apply destroy unlock lock commit-state backup-keys spot-check spot-price safe-apply cost ssh-config

# Decrypt secrets before running terraform
SECRETS_FILE := secrets.yaml
TFVARS_FILE := terraform.tfvars

# Instance types to check (primary and fallbacks)
INSTANCE_TYPES := m7g.xlarge m6g.xlarge c7g.xlarge r7g.large
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
	@echo "  make spot-check  - Check Spot capacity before deploy"
	@echo "  make spot-price  - Show current Spot prices"
	@echo "  make cost        - Show current month's AWS cost"
	@echo "  make ssh-config  - Generate SSH config for local machine"
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

# Restore from backup (on new machine)
restore-keys:
	@echo "To restore:"
	@echo "1. Save git-crypt key (base64) to a file, then:"
	@echo "   base64 -d keyfile.b64 > /tmp/git-crypt-key"
	@echo "   git-crypt unlock /tmp/git-crypt-key"
	@echo "   rm /tmp/git-crypt-key"
	@echo ""
	@echo "2. Save age key to ~/.config/sops/age/keys.txt"

# Check Spot placement scores (capacity availability)
spot-check:
	@echo "=== Spot Placement Scores (1-10, higher = better availability) ==="
	@echo ""
	@aws ec2 get-spot-placement-scores \
		--instance-types $(INSTANCE_TYPES) \
		--target-capacity 1 \
		--single-availability-zone \
		--region-names $(AWS_REGION) \
		--query 'SpotPlacementScores[*].{Type:InstanceTypes[0],Region:Region,AZ:AvailabilityZoneId,Score:Score}' \
		--output table 2>/dev/null || echo "Note: Requires ec2:GetSpotPlacementScores permission"
	@echo ""
	@echo "Score guide: 10=excellent, 7-9=good, 4-6=fair, 1-3=poor"
	@echo "Recommendation: Deploy when primary instance type scores >= 7"

# Show current Spot prices
spot-price:
	@echo "=== Current Spot Prices in $(AWS_REGION) ==="
	@echo ""
	@aws ec2 describe-spot-price-history \
		--instance-types $(INSTANCE_TYPES) \
		--product-descriptions "Linux/UNIX" \
		--start-time $$(date -u +%Y-%m-%dT%H:%M:%SZ) \
		--region $(AWS_REGION) \
		--query 'SpotPriceHistory[*].{Type:InstanceType,AZ:AvailabilityZone,Price:SpotPrice}' \
		--output table 2>/dev/null
	@echo ""
	@echo "Compare to on-demand pricing for savings estimate"

# Pre-deploy check (runs spot-check before apply)
safe-apply: spot-check decrypt-secrets
	@echo ""
	@read -p "Proceed with deployment? [y/N] " confirm && [ "$$confirm" = "y" ] || exit 1
	terraform apply
	@$(MAKE) commit-state

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
