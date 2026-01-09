# ServiceDesk Plus Ticket Workflow

> **Context:** Work only. Requires `CONTEXT=work`. If not in work context, suggest: `cd ~/work` or `ctx work`.

A skill for managing ServiceDesk Plus tickets with local workspace and automatic sync.

## Problem

When working on tickets:
- Context gets lost between sessions
- Notes are scattered or lost
- Difficult to track what was tried
- Replies to users mixed with internal notes

## Solution

**Two-way sync** between local workspace and SDP:

```
Local (working copy)              SDP (source of truth)
─────────────────────────────────────────────────────────
notes.md                    →     Private Notes
(discoveries, root cause,         (technicians only)
 things tried, code refs)

replies/2025-01-08.md       →     Public Reply
(drafted, reviewed)               (visible to requester)
```

## Quick Start

```bash
# List your assigned tickets
sdp-api list

# Start working on a ticket
sdp-work start 12345

# Work in the ticket directory
cd ~/work/tickets/SDP-12345

# Add notes as you investigate
# (edit notes.md)

# Sync notes to SDP (private)
sdp-work sync

# Draft reply to requester
sdp-work reply

# Send the reply (public)
sdp-work send-reply

# Finish up
sdp-work done
```

## Directory Structure

```
~/work/tickets/
└── SDP-12345/
    ├── .ticket.json          # Cached ticket metadata from SDP
    ├── .sync-state.json      # Track what's been synced
    ├── .sdp-notes.txt        # Notes pulled from SDP
    ├── notes.md              # Your working notes → PRIVATE in SDP
    ├── replies/              # Reply drafts → PUBLIC in SDP
    │   ├── 2025-01-08.md
    │   └── 2025-01-08.sent.md  # Archived after sending
    └── files/                # Attachments, screenshots, logs
```

## Commands

### sdp-api (Low-level API)

```bash
sdp-api list                         # List my assigned tickets
sdp-api get <id>                     # Get ticket details
sdp-api get <id> --json              # Get raw JSON
sdp-api note <id> "<message>"        # Add PRIVATE note
sdp-api reply <id> "<message>"       # Add PUBLIC reply
sdp-api get-notes <id>               # Get all notes from ticket
sdp-api sync-notes <id> <file>       # Sync file to SDP as private note
sdp-api status <id> "<status>"       # Update ticket status
sdp-api search "<query>"             # Search tickets
```

### sdp-work (Workflow Manager)

```bash
sdp-work start <id>       # Create workspace, pull ticket
sdp-work sync [<id>]      # Sync notes.md to SDP (private)
sdp-work reply [<id>]     # Create/edit reply draft
sdp-work send-reply [<id>] # Send reply to requester (public)
sdp-work done [<id>]      # Final sync, update status
sdp-work status           # Show current ticket context
```

## Notes vs Replies

| Type | Visibility | Use For |
|------|------------|---------|
| **note** | Technicians only | Root cause, things tried, internal discussion |
| **reply** | Requester + technicians | Status updates, questions, resolutions |

### Notes (`notes.md`)

Internal documentation synced as **private technician notes**:
- Investigation findings
- Root cause analysis
- Things tried (and failed)
- Related code/files
- Links to similar issues

### Replies (`replies/`)

Polished responses sent as **public replies**:
- Status updates to requester
- Questions for clarification
- Resolution summaries
- Next steps

## Workflow Example

```bash
# 1. See what's assigned to you
$ sdp-api list
ID       Subject                          Priority  Status
12345    Login timeout after upgrade      High      Open
67890    Permission denied on reports     Medium    Open

# 2. Start working on the urgent one
$ sdp-work start 12345
Setting up ticket SDP-12345...
Fetching ticket from SDP...
Ticket workspace ready: ~/work/tickets/SDP-12345

# 3. Enter the workspace
$ cd ~/work/tickets/SDP-12345

# 4. Investigate the issue, add notes
$ vim notes.md
# Add: "Checked auth logs - tokens expiring after 30min instead of 8hr"
# Add: "Found config change in last deploy - session.timeout = 1800"

# 5. Sync your findings to SDP (private)
$ sdp-work sync
Notes synced to SDP-12345

# 6. Fix the issue...

# 7. Draft reply to requester
$ sdp-work reply
Reply file: ~/work/tickets/SDP-12345/replies/2025-01-08.md

$ vim replies/2025-01-08.md
# Write: "The issue was caused by a configuration change.
#         Session timeout has been restored. Please try logging in again."

# 8. Send the reply
$ sdp-work send-reply
Sending reply to requester...
Send this reply? [y/N] y
Reply sent and archived

# 9. Finish up
$ sdp-work done
Update ticket status? [y/N] y
New status: Resolved
Work on SDP-12345 complete
```

## Configuration

Set via environment variables (store secrets in Bitwarden Secrets Manager):

```bash
export SDP_BASE_URL="https://sdp.example.com"
export SDP_API_KEY="your-api-key"
export SDP_TECHNICIAN_ID="your-tech-id"  # Optional, for filtering
export SDP_TICKETS_DIR="$HOME/work/tickets"  # Optional, default shown
```

## Installation

```bash
# Copy scripts to path
cp src/sdp-api.sh ~/bin/sdp-api
cp src/sdp-work.sh ~/bin/sdp-work
chmod +x ~/bin/sdp-api ~/bin/sdp-work

# Create tickets directory
mkdir -p ~/work/tickets

# Set environment variables
# (add to .zshrc or use direnv)
```

## Integration with PAI

This skill works alongside PAI's history system:

| System | Purpose |
|--------|---------|
| **PAI History** | General session logging, learnings, research |
| **SDP Skill** | Ticket-specific notes, synced to ticketing system |

Your ticket notes are:
1. Stored locally in `~/work/tickets/SDP-*/notes.md`
2. Synced to SDP as private technician notes
3. Searchable across all tickets locally
4. Preserved in SDP even if local files are lost

## Verification

- [ ] `sdp-api list` returns your assigned tickets
- [ ] `sdp-api get <id>` returns ticket details
- [ ] `sdp-work start <id>` creates workspace
- [ ] `sdp-work sync` pushes notes to SDP
- [ ] Notes appear in SDP as private (not visible to requester)
- [ ] `sdp-work send-reply` sends public response
