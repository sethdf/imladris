# Imladris 2.0 - Detailed Workflow Review

This document walks through every major workflow with step-by-step scenarios showing exactly what happens at each stage.

---

## 1. Daily Startup Flow

### Scenario: Monday morning, starting work

```
User: ssh imladris
```

**What happens:**

```
1. SSH via Tailscale (no public ports)
   └── Connects to imladris instance

2. Shell loads, checks LUKS
   └── If LUKS not mounted: "LUKS volume not mounted. Run: imladris-unlock"
   └── If LUKS mounted: continues

3. User: tmux attach
   └── Attaches to "main" session (persisted across SSH disconnects)
   └── Lands on last-used window

4. User: Ctrl-b 0 (or /status)
   └── Switches to Window 0: Status Dashboard
```

**Status Dashboard shows:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  IMLADRIS STATUS                                          09:15 Mon Jan 29  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  WORKSPACES                           │  CALENDAR (next 4 hours)            │
│  ─────────────────────────────────────│──────────────────────────────────── │
│  work:comms     4 actionable          │  09:30  Team standup (work)         │
│  work:tasks     7 actionable          │  10:00  1:1 with manager (work)     │
│  work:projects  2 owned               │  11:30  Dentist (home)              │
│  work:research  -                     │                                     │
│  work:adhoc     -                     │                                     │
│  ─────────────────────────────────────│                                     │
│  home:comms     2 actionable          │  AUTH STATUS                        │
│  home:tasks     1 actionable          │  ────────────────────────────────── │
│  home:projects  -                     │  ✓ ms365      ✓ sdp                 │
│  home:research  -                     │  ✓ devops     ✓ google              │
│  home:adhoc     -                     │  ✓ slack      ✓ telegram            │
│                                       │                                     │
│  SYNC STATUS                          │  LAST SYNC                          │
│  ─────────────────────────────────────│──────────────────────────────────── │
│  Pending: 0  Failed: 0  Processing: 0 │  All services: 2 min ago            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**User decides to start work:**

```
User: /work
```

**What happens:**

```
1. Zone switch command received
   └── Current zone: (none or home from yesterday)
   └── Target zone: work
   └── Target mode: comms (default)

2. SessionStart hook fires
   └── Reads WORKSPACE_NAME=work:comms
   └── Loads ~/.claude/history/workspaces/work:comms.md
   └── Injects context into Claude session

3. tmux switches to Window 1 (work:comms)
   └── Status bar turns BLUE (work zone)
   └── Prompt shows [work:comms]

4. Claude shows:
   "Good morning! Resuming work:comms.

   Last session: Friday 5:30pm - Cleared inbox, replied to 3 threads.

   Current inbox (4 actionable):
   1. [email] Budget review request - CFO (2 days old)
   2. [email] Architecture decision needed - Tech Lead (1 day old)
   3. [slack] API design question - @alex (4 hours old)
   4. [email] Meeting follow-up - PM (3 hours old)

   Process oldest first, or pick specific item?"
```

---

## 2. Processing Email (Comms Mode)

### Scenario: Reply to budget review email

```
User: "Let's handle the budget email"
```

**What happens:**

```
1. Claude loads full item from datahub
   └── Reads ~/work/datahub/items/ms365-AAMkBudget123.md
   └── Shows full email body
   └── Shows thread history (if reply chain)
   └── Shows sender context (previous interactions from memory)

2. Claude presents:
   "From: CFO <cfo@company.com>
    Subject: Q3 Budget Review Request
    Received: Saturday 10:15am

    Body:
    Hi Seth, please review the Q3 budget allocations and provide
    your input by Wednesday. Key areas: cloud infrastructure,
    tooling, contractor costs.

    [Attachment: Q3-Budget-Draft.xlsx - 245KB]

    ---
    How would you like to respond?"
```

```
User: "Draft a reply saying I'll review by tomorrow and have
       questions about the contractor line item"
```

**What happens:**

```
1. Claude (Comms skill) drafts reply:
   "Subject: Re: Q3 Budget Review Request

    Hi [CFO name],

    Thank you for sending this over. I'll review the Q3 budget
    allocations and have my input ready by tomorrow (Tuesday).

    Initial question: could you provide more context on the
    contractor costs line item? I want to ensure my review
    accounts for any planned changes there.

    Best,
    Seth"

2. Claude asks:
   "Draft ready. [Send] [Revise] [Cancel]?"
```

```
User: "Send it"
```

**What happens:**

```
1. /comms send executes
   └── Creates queue item in ~/work/datahub/queue/pending/
   └── Queue item: { action: "reply", item_id: "ms365-AAMkBudget123", body: "..." }

2. Queue processor picks up (within seconds)
   └── Calls auth-keeper get work-ms365
   └── Gets valid OAuth token (auto-refreshed if needed)
   └── Sends via MS365 Graph API: POST /messages/{id}/reply

3. On success:
   └── Queue item moves to completed/
   └── Local item updated with reply record
   └── Claude confirms: "Reply sent. Mark as processed?"
```

```
User: "Yes"
```

**What happens:**

```
1. /comms done ms365-AAMkBudget123 executes
   └── Updates item: triage: actionable → keep
   └── Item remains in datahub (searchable)
   └── Removed from actionable inbox count

2. Claude shows:
   "Done. 3 actionable items remaining.
    Next: Architecture decision email?"
```

---

## 3. Task Work Flow

### Scenario: Working on an SDP ticket

```
User: /work tasks
```

**What happens:**

```
1. Mode switch within same zone (work)
   └── Medium friction: brief context summary

2. Claude saves work:comms context
   └── Writes to ~/.claude/history/workspaces/work:comms.md

3. tmux switches to Window 2 (work:tasks)
   └── SessionStart hook fires
   └── Loads ~/.claude/history/workspaces/work:tasks.md
   └── If CURRENT_TASK set, also loads task context

4. Claude shows:
   "Switching to work:tasks.

    Last session: Friday - Working on SDP-123 (auth token bug).
    Found root cause in TokenManager.ts.

    Current task: SDP-123 - Auth token refresh failing
    Status: in-progress

    Actionable tasks (7):
    > SDP-123  Auth token refresh failing      [in-progress] ← current
      SDP-456  Add rate limiting to API        [open]
      SDP-789  Update user dashboard           [open]
      ...

    Continue SDP-123, or switch?"
```

```
User: "Continue. Where were we?"
```

**What happens:**

```
1. Claude loads task context
   └── Reads ~/.claude/history/tasks/sdp-123.md
   └── Contains: progress, findings, next steps, open files

2. Claude shows:
   "Resuming SDP-123.

    Progress:
    ✓ Reproduced issue locally
    ✓ Found root cause in TokenManager.ts:142
    → Implementing fix (you were here)
    ○ Write tests
    ○ Verify fix

    Key findings:
    - 401 during refresh causes infinite loop
    - Need to check token expiry BEFORE refresh attempt

    Last file: src/auth/TokenManager.ts:142

    Ready to continue implementing the fix?"
```

**User works on the code, then:**

```
User: /task note "Implemented retry logic with exponential backoff.
       Still need to add the pre-check for token expiry."
```

**What happens:**

```
1. Note added to local item
   └── Appends to ~/work/datahub/items/sdp-123.md under ## Notes
   └── Timestamp: 2026-01-29 09:45 (local)

2. Queue item created for sync
   └── ~/work/datahub/queue/pending/note-sdp-123-{timestamp}.json
   └── { action: "add_note", item_id: "sdp-123", text: "..." }

3. Queue processor syncs to SDP
   └── POST /api/v3/requests/123/notes
   └── Note appears in SDP within seconds

4. Claude confirms:
   "Note added and synced to SDP."
```

### Scenario: Switching tasks mid-work

```
User: /task switch sdp-456
```

**What happens:**

```
1. TaskContext skill activates

2. Saves current task context
   └── Summarizes current work: "Implementing retry logic..."
   └── Writes to ~/.claude/history/tasks/sdp-123.md
   └── Records: open files, cursor positions, pending changes

3. Updates environment
   └── CURRENT_TASK=sdp-456

4. Loads new task context
   └── Reads ~/.claude/history/tasks/sdp-456.md (if exists)
   └── Or creates fresh context from datahub item

5. Claude shows:
   "Paused SDP-123: Implementing retry logic with backoff.

    Switching to SDP-456: Add rate limiting to API

    This is a fresh task. No previous context.

    From SDP:
    - Title: Add rate limiting to API
    - Priority: P2
    - Description: Implement rate limiting for public endpoints...

    Where would you like to start?"
```

---

## 4. Parallel Work (Split Panes)

### Scenario: Claude is generating code, you want to work on something else

```
User: "Generate the complete rate limiting middleware with tests"
```

Claude starts generating (takes 30+ seconds)...

```
User: /task split sdp-789
```

**What happens:**

```
1. tmux splits current pane horizontally
   ┌─────────────────────────────────────────────────────────────────┐
   │ Pane 1: Claude generating rate limiting code...                 │
   │ [still running]                                                 │
   ├─────────────────────────────────────────────────────────────────┤
   │ Pane 2: New Claude session                                      │
   │ [cursor here]                                                   │
   └─────────────────────────────────────────────────────────────────┘

2. New pane starts fresh Claude Code session
   └── Sets CURRENT_TASK=sdp-789
   └── SessionStart hook loads sdp-789 context

3. New Claude shows:
   "Starting SDP-789: Update user dashboard

    From SDP:
    - Title: Update user dashboard
    - Priority: P3
    - Description: Add new metrics widgets...

    Ready to work."
```

**Both panes work independently:**
- Pane 1: Finishes generating, you can review later
- Pane 2: You work interactively on different task

```
User: /task merge
```

**What happens:**

```
1. Saves Pane 2 context
   └── Writes sdp-789 context to history

2. Closes Pane 2
   └── tmux closes the split

3. Returns to Pane 1 (original task)
   └── Shows any output from the generation
```

---

## 5. Zone Switch (Work to Home)

### Scenario: Personal errand during lunch

```
User: /home
```

**What happens:**

```
1. Zone switch detected (work → home)
   └── Higher friction: full context save + confirmation

2. Claude prompts:
   "Switching from work to home.

    Current work context:
    - Mode: tasks
    - Task: SDP-456 (rate limiting)
    - Status: Implementing middleware

    Save context and switch? [Yes/No]"
```

```
User: "Yes"
```

**What happens:**

```
1. SessionEnd hook fires
   └── Generates summary of work session
   └── Writes to ~/.claude/history/workspaces/work:tasks.md
   └── Writes to ~/.claude/history/tasks/sdp-456.md

2. tmux switches to Window 6 (home:comms)
   └── Status bar turns GREEN (home zone)
   └── Prompt shows [home:comms]

3. SessionStart hook fires
   └── Loads ~/.claude/history/workspaces/home:comms.md

4. Claude shows:
   "Switched to home:comms.

    Last session: Sunday - Checked personal email.

    Current inbox (2 actionable):
    1. [email] Dentist appointment confirmation
    2. [telegram] Mom asking about weekend plans

    What would you like to handle?"
```

---

## 6. Adhoc Work Flow

### Scenario: Quick investigation not tied to any ticket

```
User: /work adhoc
```

**What happens:**

```
1. Mode switch to adhoc
   └── Loads work:adhoc context

2. Claude shows:
   "Entering work:adhoc.

    Recent adhoc sessions:
    - Yesterday 16:32 - Debugging npm install hang (SDP: adhoc-14)
    - 3 days ago - Testing new tmux config (SDP: adhoc-13)

    Continue recent session or start fresh?"
```

```
User: /adhoc new "Investigating memory leak in auth service"
```

**What happens:**

```
1. Creates local datahub item
   └── id: adhoc-2026-01-29-11-30
   └── source: adhoc
   └── type: general-task
   └── title: "Investigating memory leak in auth service"
   └── triage: actionable

2. Queues sync to SDP as General Task
   └── Creates standalone task (not linked to request/problem/change)
   └── Returns SDP task ID

3. Sets CURRENT_TASK
   └── CURRENT_TASK=adhoc-2026-01-29-11-30

4. Claude shows:
   "Created adhoc task: Investigating memory leak in auth service
    SDP: General Task #15

    Ready to investigate. What's the first symptom?"
```

**After investigation:**

```
User: /adhoc close "Found the leak - unbounded cache in SessionManager.
       Created SDP-890 for the fix."
```

**What happens:**

```
1. Updates local item
   └── status: complete
   └── Adds closing notes

2. Syncs to SDP
   └── Marks General Task #15 as complete
   └── Adds resolution notes

3. Claude confirms:
   "Adhoc task closed. Synced to SDP.

    Back to recent adhoc list, or switch modes?"
```

---

## 7. Research Flow

### Scenario: Learning about a new technology

```
User: /work research
```

**What happens:**

```
1. Mode switch to research
   └── Loads work:research context

2. Claude shows:
   "Entering work:research.

    Recent research topics:
    - AWS cost optimization (last: 2 days ago)
    - Nix flakes patterns (last: 1 week ago)
    - Zero trust architecture (last: 2 weeks ago)

    Continue one of these, or start new research?"
```

```
User: /research new "Kubernetes observability with OpenTelemetry"
```

**What happens:**

```
1. Creates research topic file
   └── ~/.claude/history/research/k8s-opentelemetry.md

2. NO datahub item (research is local-only)
   └── No SDP sync
   └── Just PAI history/context

3. Sets research topic context
   └── RESEARCH_TOPIC=k8s-opentelemetry

4. Claude shows:
   "Starting research: Kubernetes observability with OpenTelemetry

    I'll help you explore this topic. What aspect would you
    like to start with?
    - Architecture overview
    - Instrumentation patterns
    - Comparison with alternatives
    - Hands-on implementation"
```

**Research notes are auto-saved:**

```
User: "Let's understand the architecture first"
```

Claude explains, user asks questions, discusses...

When done or switching:

```
1. PreCompact hook (or SessionEnd) fires
   └── Summarizes research findings
   └── Writes to ~/.claude/history/research/k8s-opentelemetry.md
   └── Key learnings captured for next session
```

---

## 8. Project Ownership Flow

### Scenario: Checking on a project you own

```
User: /work projects
```

**What happens:**

```
1. Mode switch to projects
   └── Loads work:projects context

2. Claude shows:
   "Entering work:projects.

    Your projects (2 owned):

    1. Imladris 2.0 (local)
       Status: In Progress
       Open tasks: 3
       - Build email poller
       - Implement triage skill
       - Create status TUI

    2. Q1 Security Audit (SDP Project)
       Status: In Progress
       Open tasks: 12
       Next milestone: Feb 15

    Select a project to see details and tasks."
```

```
User: "Show me the Security Audit"
```

**What happens:**

```
1. Claude fetches project details
   └── Reads from datahub (synced from SDP)
   └── Shows task breakdown

2. Claude shows:
   "Q1 Security Audit (SDP Project #45)

    Owner: Seth (you)
    Status: In Progress
    Timeline: Jan 15 - Mar 15
    Progress: 8/20 tasks complete (40%)

    Open tasks by priority:
    P1 (3):
    - SDP-901: Penetration test scheduling
    - SDP-902: Vulnerability scan review
    - SDP-903: Access audit for prod

    P2 (5):
    - SDP-904: Update security policies
    ...

    Milestones:
    ✓ Jan 15: Kickoff
    → Feb 15: Initial findings report (upcoming)
    ○ Mar 1: Remediation plan
    ○ Mar 15: Final report

    What would you like to do?"
```

---

## 9. Auth Failure Recovery

### Scenario: Token expired mid-work

Status bar shows: `⚠ sdp auth`

```
User: auth-keeper status
```

**Shows:**

```
Service Status:
─────────────────────────────────────────
✓ work-ms365      Token valid (expires in 45min)
✓ work-devops     PAT valid (expires in 89 days)
✓ work-slack      Session valid
✗ work-sdp        Token expired (refresh failed)
✓ home-google     Token valid (expires in 2h)
✓ home-telegram   Bot token (never expires)

work-sdp: Refresh token may have expired.
Run: auth-keeper setup work-sdp
```

```
User: auth-keeper setup work-sdp
```

**What happens:**

```
1. Opens browser for Zoho OAuth flow
   └── "Opening browser for SDP authentication..."

2. User completes OAuth in browser
   └── Grants permissions
   └── Callback captured

3. Tokens stored
   └── Access token + refresh token saved
   └── Encrypted with age before writing
   └── Stored in /data/config/auth-keeper/

4. Verification:
   └── Test API call to SDP
   └── "SDP authentication successful. Token valid for 1 hour."

5. Status bar clears warning
   └── Pollers resume
   └── Queue items retry
```

---

## 10. New Service Integration

### Scenario: Adding Jira to the system

```
User: (adds jira-api-token to BWS)
```

Next time auth-keeper runs:

```
User: auth-keeper discover
```

**What happens:**

```
1. Scans BWS for new/unknown secrets
   └── Finds: jira-api-token (not in registry)

2. Prompts:
   "New secret found: jira-api-token

    What service is this for? Jira Cloud
    Zone? (work/home) work

    Renaming to: work-jira-api-token"

3. Creates integration task automatically:
   └── Creates ~/work/datahub/items/local-integrate-jira-20260129.md
   └── triage: actionable
   └── Checklist:
       □ Create poller
       □ Create CLI commands
       □ Create PAI skill via CreateSkill
       □ Add to datahub sources
       □ Test sync cycle
       □ Document in CLAUDE.md

4. Claude (next session) shows:
   "New integration task created: Build integration for jira

    This appeared in your work:tasks inbox. Would you like
    to start working on it?"
```

---

## 11. Git Automation Flow

### Scenario: Coding with auto-commit

```
User: (working on SDP-456 in work:tasks)
User: "Implement the rate limiting middleware"
```

**What happens during coding:**

```
1. Claude writes code to src/middleware/rateLimit.ts

2. gitwatch detects file change
   └── Debounce: waits 30 seconds for more changes

3. Pre-commit scan runs
   └── gitleaks scans for secrets
   └── If clean: proceed
   └── If secrets found: BLOCK, alert user

4. Auto-commit (invisible to user)
   └── git add src/middleware/rateLimit.ts
   └── git commit -m "WIP: 2026-01-29 11:45 - rateLimit.ts"
   └── Branch: wip/sdp-456

5. Auto-push to GitHub
   └── git push origin wip/sdp-456
   └── Work is now safe on GitHub
```

**When work is verified:**

```
User: /verify
```

**What happens:**

```
1. Spec Kit runs acceptance criteria
   └── Runs tests
   └── Checks requirements

2. If tests pass:
   └── Squash all WIP commits into one
   └── Clean commit message from spec
   └── Merge to main
   └── Push main to GitHub
   └── Delete wip/sdp-456 branch

3. Claude shows:
   "All acceptance criteria passed.

    Squashed 12 WIP commits → 1 clean commit
    Merged to main
    Pushed to GitHub

    SDP-456 ready to close?"
```

---

## 12. Error and Edge Cases

### Scenario: Concurrent context writes (two panes)

```
Pane 1: Working on SDP-123, saves context at 14:32:01
Pane 2: Also has SDP-123 open, saves context at 14:32:02
```

**What happens:**

```
1. Pane 1 acquires file lock
   └── Writes to ~/.claude/history/tasks/sdp-123.md
   └── Releases lock

2. Pane 2 attempts write
   └── Lock acquired
   └── Detects file changed since read
   └── Attempts merge:
       - Different sections: auto-merge
       - Same section: last-write-wins, backup created

3. Result:
   └── sdp-123.md contains merged context
   └── sdp-123.md.backup contains Pane 1's version
   └── Warning logged (but doesn't interrupt user)
```

### Scenario: Item deleted externally while pending write

```
User: /task note "Progress update"
(Meanwhile, someone deletes the ticket in SDP)
```

**What happens:**

```
1. Queue processor attempts sync
   └── POST /api/v3/requests/123/notes
   └── Response: 404 Not Found

2. Queue processor handles:
   └── Moves to failed/
   └── Logs: "Item sdp-123 not found in external system"

3. Next user interaction, Claude shows:
   "Warning: SDP-123 was deleted externally.

    Local item still exists. Options:
    [Keep local] [Delete local] [Recreate in SDP]"
```

### Scenario: Rate limit hit

```
Poller fetches from MS365, hits rate limit
```

**What happens:**

```
1. API returns 429 Too Many Requests
   └── Includes Retry-After header

2. Poller handles:
   └── Logs: "MS365 rate limited, backing off"
   └── Exponential backoff: 1s, 2s, 4s, 8s...
   └── Max backoff: 5 minutes

3. After backoff:
   └── Resumes from last sync point
   └── Continues normally

4. If 3+ consecutive failures:
   └── Alert via SimpleX/Telegram
   └── Status dashboard shows warning
```

### Scenario: Disk space critical

```
Disk reaches 95% capacity
```

**What happens:**

```
1. Monitoring detects threshold

2. Automatic actions:
   └── Pollers paused (prevent more data)
   └── Auto-purge old queue/completed (>7 days)
   └── Auto-purge old trash (>30 days, emergency mode)

3. Alert sent:
   └── SimpleX + Telegram: "CRITICAL: Disk 95% full"
   └── Status dashboard: red warning

4. User intervention required:
   └── Manual cleanup of repos/
   └── Review large items
   └── Consider expanding EBS volume
```

---

## 13. Complete Day Example

### Full day walkthrough

**9:00 AM - Start work**
```
ssh imladris → tmux attach → /status → /work
```
- See 4 emails, 7 tasks
- Start with comms (default)

**9:00-9:25 AM - Process comms**
```
/work comms → process 4 emails → /comms done each
```
- Reply to 2, archive 2
- Inbox zero for now

**9:30-10:00 AM - Standup meeting**
- Use calendar merge view
- Meeting notes captured elsewhere

**10:00-12:00 PM - Deep task work**
```
/work tasks → /task start sdp-456
```
- Code with auto-commit
- `/task note` for progress
- gitwatch handles git

**12:00 PM - Quick home errand**
```
/home → check personal email → /home tasks → pay bill
```
- Zone switch saves work context
- Handle 1 home item
- `/home` only took 10 minutes

**12:15 PM - Back to work**
```
/work tasks
```
- Context restored automatically
- "Resuming SDP-456: You were implementing..."

**12:15-2:00 PM - Continue task work**
- Finish implementation
- `/verify` passes
- Squash + merge + push

**2:00 PM - Quick research**
```
/work research → /research new "Alternative to X"
```
- 30 min exploration
- Notes auto-saved to PAI history

**2:30-5:00 PM - More tasks**
```
/work tasks → work on SDP-789
```
- Mid-afternoon, Slack pops up urgent
- `/task split` to handle in parallel
- Return to main task

**5:00 PM - End of day**
```
/status → review sync status → Ctrl-b d (detach)
```
- All synced
- Context saved
- SSH disconnect

---

## Summary: What Makes It Work

| Principle | Implementation |
|-----------|----------------|
| Context never lost | Hooks save on every transition |
| Friction is intentional | Zone switches require confirmation |
| Everything syncs | Pollers + queue processor |
| Plain text everywhere | Grep/search always works |
| Auth is invisible | auth-keeper handles tokens |
| Git is automatic | gitwatch + secrets scanning |
| Errors are recoverable | Retry logic, backups, alerts |
