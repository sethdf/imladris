# ServiceDesk Plus Ticket Workflow

A PAI skill for managing ServiceDesk Plus tickets with session tracking.

## Problem

When working on tickets, context gets lost between sessions. You need:
- Quick access to assigned tickets
- Automatic session logging per ticket
- Easy updates back to the ticketing system
- All work organized by ticket, not by time

## Solution

This skill provides ticket-centric workflow management:
- List and fetch tickets from ServiceDesk Plus API
- Create working directories per ticket
- Track sessions within ticket context
- Push updates back to ServiceDesk Plus

## Configuration

Set these environment variables (store in Bitwarden Secrets Manager):

```bash
export SDP_BASE_URL="https://sdp.example.com"      # Your SDP instance
export SDP_API_KEY="your-api-key"                   # API technician key
export SDP_TECHNICIAN_ID="your-tech-id"             # Your technician ID
```

## Directory Structure

```
~/work/tickets/
├── SDP-12345/
│   ├── .ticket.json      # Cached ticket metadata
│   ├── session.md        # Current session notes
│   ├── notes.md          # Accumulated notes across sessions
│   └── files/            # Related files, code, etc.
└── SDP-67890/
    └── ...
```

---

## Commands

### List My Tickets

**Trigger**: "list tickets", "my tickets", "show assigned tickets"

**Workflow**:
1. Call `sdp-api list` to fetch tickets assigned to me
2. Display as formatted table:
   ```
   ID       | Subject                          | Priority | Status
   ---------|----------------------------------|----------|--------
   SDP-123  | Fix login timeout issue          | High     | Open
   SDP-456  | Update user permissions          | Medium   | In Progress
   ```
3. Ask which ticket to work on

---

### Work On Ticket

**Trigger**: "work on SDP-12345", "open ticket 12345", "start SDP-12345"

**Workflow**:
1. Extract ticket ID from user input
2. Create ticket directory if not exists:
   ```bash
   mkdir -p ~/work/tickets/SDP-{id}/{files,sessions}
   ```
3. Fetch ticket details:
   ```bash
   sdp-api get {id} > ~/work/tickets/SDP-{id}/.ticket.json
   ```
4. Change to ticket directory:
   ```bash
   cd ~/work/tickets/SDP-{id}
   ```
5. Load existing notes.md if present
6. Start session log with header:
   ```markdown
   ## Session: {timestamp}

   **Ticket**: SDP-{id}
   **Subject**: {subject}
   **Priority**: {priority}
   **Status**: {status}

   ### Work Log
   ```
7. Display ticket summary to user
8. Ask "What would you like to work on?"

---

### Update Ticket

**Trigger**: "update ticket", "add note to ticket", "post update"

**Workflow**:
1. Confirm we're in a ticket directory (check for .ticket.json)
2. If message provided, use it; otherwise ask for update text
3. Post to ServiceDesk Plus:
   ```bash
   sdp-api note {id} "{message}"
   ```
4. Append to local session.md:
   ```markdown
   **Update posted** ({timestamp}): {message}
   ```
5. Confirm success

---

### Change Ticket Status

**Trigger**: "set status to {status}", "mark as in progress", "close ticket"

**Workflow**:
1. Map user intent to SDP status:
   - "in progress", "working" → "In Progress"
   - "done", "complete", "close" → "Resolved"
   - "waiting", "pending" → "On Hold"
2. Update ticket:
   ```bash
   sdp-api status {id} "{status}"
   ```
3. Log status change in session.md
4. Confirm success

---

### Show Ticket Details

**Trigger**: "show ticket", "ticket details", "what's this ticket about"

**Workflow**:
1. Read .ticket.json from current directory
2. Display formatted:
   ```
   Ticket: SDP-{id}
   Subject: {subject}

   Description:
   {description}

   Priority: {priority}
   Status: {status}
   Created: {created_time}
   Due: {due_by_time}
   ```

---

### End Session

**Trigger**: "done with ticket", "end session", "wrap up"

**Workflow**:
1. Ask for session summary (or generate from work log)
2. Append summary to notes.md:
   ```markdown
   ## {date} - Session Summary
   {summary}

   Files changed: {list}
   ```
3. Optionally post summary to ticket as note
4. Ask if status should be updated
5. Return to home directory

---

### Search Tickets

**Trigger**: "search tickets for {query}", "find ticket about {topic}"

**Workflow**:
1. Search local ticket directories:
   ```bash
   grep -r "{query}" ~/work/tickets/*/notes.md
   ```
2. Search SDP if no local results:
   ```bash
   sdp-api search "{query}"
   ```
3. Display matching tickets

---

## Context Hook

When entering a ticket directory, automatically load context:

```typescript
// On directory change, if .ticket.json exists:
// 1. Read ticket metadata
// 2. Load notes.md
// 3. Set ticket context for session
```

---

## API Reference

The `sdp-api` helper script handles all ServiceDesk Plus interactions:

```bash
sdp-api list                    # List my assigned tickets
sdp-api get {id}                # Get ticket details (JSON)
sdp-api note {id} "{message}"   # Add note to ticket
sdp-api status {id} "{status}"  # Update ticket status
sdp-api search "{query}"        # Search tickets
```

---

## Installation

1. Copy `src/sdp-api.sh` to `~/bin/sdp-api`
2. Set environment variables (SDP_BASE_URL, SDP_API_KEY, SDP_TECHNICIAN_ID)
3. Create work directory: `mkdir -p ~/work/tickets`
4. Copy this skill to `~/.claude/skills/servicedesk-plus.md`

---

## Verification

- [ ] `sdp-api list` returns your assigned tickets
- [ ] `sdp-api get {id}` returns ticket JSON
- [ ] Working directory exists at `~/work/tickets/`
- [ ] Environment variables are set
