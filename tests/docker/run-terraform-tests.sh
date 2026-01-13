#!/bin/bash
# Run Terraform validation tests
set -euo pipefail

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                   Terraform Validation                          ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

cd /project

# Check for Terraform files
if [[ ! -f "main.tf" ]]; then
    echo "No main.tf found in project root"
    exit 1
fi

# Initialize Terraform (backend disabled for validation)
echo "Initializing Terraform..."
terraform init -backend=false -input=false

echo ""

# Format check
echo "Checking Terraform formatting..."
if terraform fmt -check -recursive; then
    echo "  Format: OK"
else
    echo "  Format: NEEDS FORMATTING"
    echo "  Run: terraform fmt -recursive"
fi
echo ""

# Validation
echo "Validating Terraform configuration..."
if terraform validate; then
    echo "  Validation: OK"
else
    echo "  Validation: FAILED"
    exit 1
fi
echo ""

# TFLint (if .tflint.hcl exists or just run defaults)
if command -v tflint &>/dev/null; then
    echo "Running tflint..."
    if tflint --init 2>/dev/null; then
        if tflint; then
            echo "  TFLint: OK"
        else
            echo "  TFLint: WARNINGS/ERRORS"
        fi
    fi
    echo ""
fi

# Check for common issues
echo "Checking for common issues..."

# Check that sensitive variables aren't in outputs
if grep -r "sensitive.*=.*false" outputs.tf 2>/dev/null; then
    echo "  WARNING: Some outputs may expose sensitive data"
fi

# Check for hardcoded credentials
if grep -rE "(password|secret|token)\s*=\s*\"[^\"]+\"" *.tf 2>/dev/null | grep -v "var\." | grep -v "local\."; then
    echo "  WARNING: Possible hardcoded credentials found"
fi

# Check template escaping in user-data
echo "  Checking Terraform template escaping..."
template_issues=0
if grep -q '\${MCP_SERVERS\[@\]}' scripts/user-data-nix.sh 2>/dev/null; then
    # Correct escaping found
    echo "    MCP_SERVERS array: OK (properly escaped)"
else
    if grep -q '\$\${MCP_SERVERS\[@\]}' scripts/user-data-nix.sh 2>/dev/null; then
        echo "    MCP_SERVERS array: OK (Terraform escaped)"
    else
        echo "    MCP_SERVERS array: MISSING or incorrectly escaped"
        ((template_issues++)) || true
    fi
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "Terraform validation complete"
