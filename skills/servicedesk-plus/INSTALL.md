# ServiceDesk Plus Skill Installation

## Prerequisites

- Claude Code installed and configured
- PAI (Personal AI Infrastructure) bootstrapped
- ServiceDesk Plus API access (technician key)

## Step 1: Set Environment Variables

Add your ServiceDesk Plus credentials to Bitwarden Secrets Manager or export directly:

```bash
# Option A: Add to BWS
bws secret create sdp-base-url --value "https://sdp.yourcompany.com"
bws secret create sdp-api-key --value "your-api-key-here"
bws secret create sdp-technician-id --value "your-tech-id"

# Option B: Add to shell profile (~/.zshrc)
export SDP_BASE_URL="https://sdp.yourcompany.com"
export SDP_API_KEY="your-api-key-here"
export SDP_TECHNICIAN_ID="your-tech-id"
```

## Step 2: Install API Helper Script

```bash
# Copy script to bin
cp src/sdp-api.sh ~/bin/sdp-api
chmod +x ~/bin/sdp-api

# Test it works
sdp-api help
sdp-api list
```

## Step 3: Create Work Directory

```bash
mkdir -p ~/work/tickets
```

## Step 4: Install Skill File

```bash
# Copy skill to PAI skills directory
mkdir -p ~/.claude/skills
cp README.md ~/.claude/skills/servicedesk-plus.md
```

## Step 5: Install Context Hook (Optional)

For automatic ticket context loading:

```bash
# Copy hook to PAI hooks directory
cp src/ticket-context-hook.ts ~/.claude/hooks/

# Add to settings.json hooks array
# Edit ~/.claude/settings.json and add:
# {
#   "hooks": [
#     {
#       "event": "SessionStart",
#       "script": "~/.claude/hooks/ticket-context-hook.ts"
#     }
#   ]
# }
```

## Step 6: Verify Installation

```bash
# Test API connection
sdp-api list

# Test directory structure
ls ~/work/tickets/

# Test skill is loaded (in Claude)
claude "list my tickets"
```

## Getting Your API Key

1. Log into ServiceDesk Plus as admin
2. Go to Admin → Technicians → Select your account
3. Generate API Key under "API Key Generation"
4. Copy the key (shown only once)

## Getting Your Technician ID

```bash
# List all technicians and find your ID
curl -s -H "authtoken: YOUR_API_KEY" \
  "https://sdp.yourcompany.com/api/v3/technicians" | jq '.technicians[] | {id, name}'
```

## Troubleshooting

### "SDP_BASE_URL not set"
Export the environment variable or add to ~/.zshrc

### "401 Unauthorized"
- Check API key is correct
- Verify key has permissions for requests API
- Check key hasn't expired

### "No tickets returned"
- Verify SDP_TECHNICIAN_ID is correct
- Check you have tickets assigned in SDP
- Try `sdp-api search "test"` to verify API works
