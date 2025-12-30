#!/bin/bash
# Script to create GitHub issues from enhancement templates
# Usage: ./create-issues.sh [--dry-run]
#
# Prerequisites:
#   - GitHub CLI (gh) installed and authenticated
#   - Run from repository root or .github/ENHANCEMENT_ISSUES directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "=== DRY RUN MODE ==="
fi

# Check for gh CLI
if ! command -v gh &> /dev/null; then
    echo "Error: GitHub CLI (gh) not found. Install from https://cli.github.com/"
    exit 1
fi

# Verify authentication
if ! gh auth status &> /dev/null; then
    echo "Error: Not authenticated with GitHub. Run 'gh auth login' first."
    exit 1
fi

echo "Creating issues from enhancement templates..."
echo

for file in "$SCRIPT_DIR"/[0-9]*.md; do
    if [[ ! -f "$file" ]]; then
        continue
    fi

    filename=$(basename "$file")

    # Extract title from first H1 heading
    title=$(grep -m1 '^# ' "$file" | sed 's/^# //')

    # Extract labels from the Labels section
    labels=$(grep -A1 '^## Labels' "$file" | tail -1 | tr -d '`' | tr ',' '\n' | xargs | tr ' ' ',')

    # Get body (everything after the title line)
    body=$(tail -n +2 "$file")

    echo "Processing: $filename"
    echo "  Title: $title"
    echo "  Labels: $labels"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "  [DRY RUN] Would create issue"
    else
        # Create the issue
        issue_url=$(gh issue create \
            --title "$title" \
            --body "$body" \
            --label "$labels" 2>&1) || {
            echo "  Error creating issue: $issue_url"
            continue
        }
        echo "  Created: $issue_url"
    fi
    echo
done

echo "Done!"
