# A Day with Imladris 2.0

> Walking through realistic scenarios to identify friction points and validate the design.

---

## 8:15 AM — Morning Startup

**Scenario:** Start of day. SSH in, see what's waiting.

```bash
$ ssh imladris
$ tmux attach

# Window 0 shows dashboard automatically
┌─────────────────────────────────────────────────┐
│ IMLADRIS STATUS           Thu Jan 30, 8:30 AM   │
├─────────────────────────────────────────────────┤
│ Inbox: 4 actionable (1 P0)                      │
│ Tasks: SDP-1234 (P0), SDP-1201, SDP-1199        │
│ Calendar: Standup 9:00, 1:1 with boss 2:00     │
│ Sync: All green ✓                               │
│ Last triage: 2 min ago                          │
└─────────────────────────────────────────────────┘

$ /work
```

Claude loads in work:tasks window:

```
Curu: Welcome back. You have a P0 ticket (SDP-1234) that came in
overnight. Last session you were working on the auth refactor
(SDP-1201) — context saved.

What would you like to focus on?
```

```
Me: let's deal with the P0 first

Curu: Loading SDP-1234...

[Context panel shows ticket details, recent notes, linked items]

I can see this is an API 500 error. Want me to:
1. Pull recent CloudWatch logs for the prod API?
2. Check if there were any deployments last night?
3. Look at the error patterns?

Me: all of them, and check if anyone else has reported this on slack
```

Claude runs multiple Windmill scripts in parallel:
- `f/aws/get-session.ts` → gets temp creds
- Direct CloudWatch API calls (interactive pattern)
- `f/slack/search.ts` → searches for related messages

**✓ Friction reduced:**
- Dashboard shows priority at a glance — no checking 5 different services
- Previous session context (auth refactor) remembered automatically
- Multi-service queries without manual auth
- Parallel execution across AWS, Slack

**⚠ Potential pain point:**
- AWS session fetch adds ~200ms before first API call
- If CloudWatch has lots of data, could be slow
- Dashboard assumes polling ran overnight — if instance was stopped, data is stale

---

## 9:00 AM — Interrupted for Standup

**Scenario:** Calendar reminder, need to pause work.

```
[Desktop notification: "Standup in 5 minutes"]

Me: /task pause

Curu: Pausing SDP-1234. Context saved:
- Identified memory leak in auth-service
- CloudWatch logs attached
- Draft response to ticket started

Resuming later will restore this context.
```

*Standup happens (15 min)*

```
Me: /task resume

Curu: Resuming SDP-1234.

Where we left off:
- Memory leak identified in auth-service (line 423)
- Cause: Connection pool not releasing on timeout
- Fix approach: Add explicit cleanup in finally block

Ready to continue with the fix?
```

**✓ Friction reduced:**
- One command to pause/resume
- Full context restored including draft work
- No "where was I?" moment

---

## 10:30 AM — P0 Resolved, Processing Inbox

**Scenario:** Ticket fixed, now catch up on comms.

```
Me: /task close "Memory leak in auth-service connection pool.
    Added cleanup in finally block. Deployed to prod, monitoring."

Curu: Closing SDP-1234...
- Status → Resolved
- Resolution notes added
- Worklog: 2h 15m logged
- Synced to ServiceDesk Plus ✓

Back to inbox. You have:
- 1 urgent email (Q3 budget from boss)
- 3 Slack messages
- 2 items triaged as 'keep' (FYI only)

Me: /mode comms
```

Window changes to work:comms

```
Curu: [work:comms] Loading communications context...

Priority items:
1. Email: "Q3 Budget needed EOD" — from boss, 7:02 AM
2. Slack DM: Sarah's PR review request
3. Slack #general: Announcement about office closure Friday

What would you like to handle first?

Me: the budget email — what's he actually asking for?

Curu: Reading email...

He's asking for:
- Department headcount projections for Q3
- Software licensing renewals (list attached)
- Conference/training budget estimate

The licensing renewal list has 12 items. I can see you have
a spreadsheet from last quarter in your email — want me to
find it as a starting point?

Me: yes, and pull the current headcount from our HR system

Curu: I don't have access to the HR system. That's not a
configured data source.

[This would require adding a new source — see later scenario]

For now, I found the Q2 spreadsheet. Want me to draft a
response based on Q2 numbers + 10% buffer?
```

**⚠ Pain point identified:**
- HR system not integrated — manual lookup needed
- This is a real friction moment

---

## 11:00 AM — Adding Ramp as a Data Source

**Scenario:** Realized expense data would help with budget. Ramp is our expense management tool.

```
Me: actually, can we add Ramp as a data source? I need expense
    data for this budget and will need it going forward

Curu: Adding a new data source requires:

1. Windmill scripts (f/ramp/*.ts)
2. Credentials in Windmill (API key or OAuth)
3. Thin Curu skill for routing
4. Datahub schema for storage

I can help create the implementation spec. What data do you
need from Ramp?

Me: transactions, categorized by department. monthly summaries
    would be useful too

Curu: Let me draft the integration spec...
```

### Creating the Ramp Integration

**Step 1: Research the API**

```
Me: research the ramp api and see what's available

Curu: [Fetches Ramp API docs]

Ramp API provides:
- /transactions - All transactions (paginated)
- /transactions/summary - Aggregated by category/dept
- /cards - Card details
- /users - Employee card assignments

Auth: API key (Bearer token)
Rate limit: 100 req/min

For your use case, I'd suggest syncing:
- /transactions (last 90 days initially, then delta)
- /transactions/summary (monthly rollups)

Want me to create the spec?

Me: yes, create an integration task for this
```

**Step 2: Auto-create Integration Task**

```
Curu: Creating integration task in SDP...

Created: SDP-1245 "Integrate Ramp expense data"
Type: Integration Task (auto-template applied)

Subtasks created:
□ Create BWS secret (work-ramp-api-key)
□ Create Windmill scripts (f/ramp/)
□ Create Curu skill (Ramp)
□ Initial sync test
□ Add to polling schedule
□ Update dashboard

Estimated: 2-3 hours

Want to start on this now or queue it for later?

Me: start now, I need the data for the budget anyway
```

**Step 3: Credentials Setup**

```
Curu: First, we need the Ramp API key.

Go to: Ramp Dashboard → Settings → Developer → API Keys
Create a read-only key and give me the value.

(I'll store it in BWS as work-ramp-api-key, then sync to Windmill)

Me: [pastes API key]

Curu: Storing in BWS...
Running bws-sync to propagate to Windmill...
Verified: work-ramp-api-key now available in Windmill ✓

Next: Creating the sync scripts.
```

**Step 4: Create Windmill Scripts**

Curu creates:

```typescript
// f/ramp/sync.ts - Scheduled poller
import * as wmill from "windmill-client";

export async function main() {
  const apiKey = await wmill.getVariable("work-ramp-api-key");
  const lastSync = await wmill.getState("ramp-last-sync") ||
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const response = await fetch("https://api.ramp.com/v1/transactions", {
    headers: { "Authorization": `Bearer ${apiKey}` },
    // ... pagination, date filter
  });

  // Write to datahub
  for (const txn of transactions) {
    await writeToDatahub("work", "ramp", txn.id, {
      amount: txn.amount,
      merchant: txn.merchant,
      category: txn.category,
      department: txn.department,
      date: txn.date,
      employee: txn.user_name,
    });
  }

  await wmill.setState("ramp-last-sync", new Date().toISOString());
}
```

```typescript
// f/ramp/get-summary.ts - On-demand query
export async function main(args: { month: string, groupBy: string }) {
  const apiKey = await wmill.getVariable("work-ramp-api-key");
  // ... fetch summary from API
  return summary;
}
```

**Step 5: Create Thin Skill**

```markdown
# Skill: Ramp

Routes Ramp expense queries to Windmill scripts in f/ramp/.

## Scripts Available
- f/ramp/sync.ts - Scheduled sync (don't call directly)
- f/ramp/get-summary.ts - Get spending summary
- f/ramp/get-transactions.ts - List transactions

## Usage Examples
- "Show me last month's expenses by department"
- "What did we spend on software in Q2?"
- "List transactions over $1000"

## Routing
1. Summary queries → f/ramp/get-summary.ts
2. Transaction lists → f/ramp/get-transactions.ts
```

**Step 6: Test & Enable**

```
Me: run an initial sync and show me January expenses

Curu: Running f/ramp/sync.ts...

Synced 847 transactions (Jan 1 - Jan 30)
Total: $234,521

By department:
- Engineering: $89,234
- Sales: $67,890
- Marketing: $45,123
- Operations: $32,274

Top categories:
- Software: $78,432
- Travel: $45,678
- Supplies: $23,456

Data now in datahub at work/ramp/*.md

Me: /task done SDP-1245

Curu: Marking complete. Ramp integration is now:
- Syncing every 5 min via Windmill
- Searchable in datahub
- Available via /search and Ramp skill
```

**✓ Friction reduced:**
- Structured process for adding sources
- Auto-created integration task with subtasks
- Scripts generated from templates
- Immediate value (got budget data)

**⚠ Pain points:**
- Still needed manual API key retrieval from Ramp UI
- Had to context-switch to browser for that step
- Initial sync took ~2 min for 847 records

---

## 12:30 PM — Lunch Break / Zone Switch

**Scenario:** Quick check on home stuff during lunch.

```
Me: /home

Curu: Switching to home zone...

[Context save: work:comms]
[Loading: home:adhoc]

Home inbox:
- Dentist appointment reminder (tomorrow 2pm)
- Amazon delivery notification
- Newsletter from HN (triaged as 'keep')

Nothing urgent. Your calendar shows clear afternoon
except for 2pm 1:1 with boss.

Me: add a reminder to leave early for dentist tomorrow

Curu: What time do you need to leave?

Me: 1:30pm

Curu: Created:
- Home calendar: "Leave for dentist" at 1:30pm tomorrow
- Blocked on work calendar: "Out - appointment" 1:30-3:30pm

Synced to both Google Calendar and MS365.

Me: /work
```

**✓ Friction reduced:**
- Zone switch with context save automatic
- Cross-calendar blocking handled
- Bidirectional sync

---

## 2:00 PM — 1:1 with Boss

**Scenario:** Need to discuss budget, pull data quickly.

```
Me: pull up the Q3 budget numbers I was working on

Curu: Loading budget context...

You were working on the response to boss's email this morning.
Current draft:

---
Q3 Budget Projection:

Headcount: [NEED HR DATA - manual lookup required]

Software Licensing: $78,432 (from Ramp data)
  - GitHub: $12,400
  - AWS: $34,000
  - Slack: $8,900
  - Others: $23,132

Training/Conferences: $15,000 (Q2 was $12,000 + 10%)

Total projected: $[pending headcount]
---

Want me to add the Ramp transaction details as backup?

Me: yes, and show me the month-over-month trend

Curu: [Calls f/ramp/get-summary.ts with groupBy=month]

Monthly spend (last 6 months):
Aug: $198,432
Sep: $212,567
Oct: $205,890
Nov: $187,654
Dec: $201,234
Jan: $234,521 ← 16% increase

The January spike is mostly AWS ($34k → $41k, new
infrastructure for the auth-service project).
```

**✓ Friction reduced:**
- Data from new Ramp integration immediately useful
- Context from earlier session preserved
- Analysis on-demand

---

## 4:30 PM — Deep Work: The Auth Refactor

**Scenario:** Finally getting to the original task from yesterday.

```
Me: /task switch SDP-1201

Curu: Switching tasks...

[Saving current context]
[Loading SDP-1201: "Auth refactor - add MFA support"]

Last session (yesterday 5:47pm):
- Created migration plan for auth tables
- Started implementing TOTP generation
- Stopped mid-function (line 234 of auth-service/mfa.ts)
- Notes: "Need to decide on backup codes approach"

Related items found today:
- Slack thread in #engineering about MFA UX (3 new messages)
- PR #892 from Sarah touches auth module (her review request)

Pick up where you left off?

Me: yes, but first show me what sarah changed in her PR

Curu: [Calls f/devops/get-pr.ts with id=892]

PR #892: "Add rate limiting to auth endpoints"
Files changed:
- auth-service/rate-limiter.ts (new file)
- auth-service/middleware.ts (+45 lines)
- auth-service/index.ts (+3 lines)

This doesn't conflict with your MFA work, but you'll want
to ensure MFA endpoints also have rate limiting.

Adding to your task notes: "Ensure MFA endpoints use new
rate limiter from PR #892"
```

*Deep work happens for 2 hours...*

---

## 6:30 PM — End of Day

**Scenario:** Wrapping up, capturing state for tomorrow.

```
Me: /task pause

Curu: Pausing SDP-1201. Saving context:

Progress today:
- Implemented TOTP generation ✓
- Implemented backup codes (10 single-use codes) ✓
- Started enrollment flow (50% complete)

Blockers:
- Need to decide: SMS fallback or app-only?
- Sarah's PR needs merge before yours

Files modified:
- auth-service/mfa.ts (324 lines added)
- auth-service/enrollment.ts (new file, 156 lines)
- tests/mfa.test.ts (89 lines added)

Tests: 12 passing, 3 pending (enrollment flow)

Tomorrow's pickup point: enrollment.ts line 67,
implementing QR code generation.

Me: /dashboard
```

Dashboard shows:
```
┌─────────────────────────────────────────────────┐
│ END OF DAY SUMMARY        Thu Jan 30, 6:30 PM   │
├─────────────────────────────────────────────────┤
│ Completed today:                                │
│ ✓ SDP-1234: P0 prod incident (2h 15m)          │
│ ✓ SDP-1245: Ramp integration (1h 30m)          │
│                                                 │
│ In progress:                                    │
│ ○ SDP-1201: Auth refactor - MFA (4h today)     │
│                                                 │
│ Tomorrow:                                       │
│ • Dentist 2pm (leave 1:30)                     │
│ • Continue MFA enrollment flow                  │
│ • Review Sarah's PR                            │
│                                                 │
│ Sync status: All green ✓                        │
│ Inbox: 2 new (both FYI, triaged 'keep')        │
└─────────────────────────────────────────────────┘
```

---

## Summary: Friction Analysis

### ✓ Friction Reduced

| Scenario | Old Pain | New Flow |
|----------|----------|----------|
| Morning startup | Check 5+ services manually for what's urgent | Dashboard shows priority at a glance |
| Context switch | "Where was I?" 15-20 min recovery | Instant restore with `/task resume` |
| Cross-service query | Auth to each service, run separate queries | Single command, parallel fetch via Windmill |
| Adding data source | Days of custom coding, systemd, etc. | 1-2 hours with templates and patterns |
| Zone switch | Mental overhead, risk of mixing contexts | `/home` or `/work`, auto-save current |
| Pause/resume | Manual notes, lost state, files half-open | Automatic context capture |
| Multi-calendar | Check both calendars, manual blocking | Automatic bidirectional sync |
| Interruptions | Lose thread, forget what was pending | Resume exactly where you left off |

### ⚠ Pain Points Identified

| Issue | Impact | Possible Fix |
|-------|--------|--------------|
| Manual API key retrieval | Context switch to browser for new sources | Can't fix (vendor limitation) |
| Missing data source (HR) | Manual lookup for some data | Add as source (same pattern as Ramp) |
| AWS session fetch latency | 200ms before first API call | Cache sessions longer, or accept it |
| Initial sync can be slow | 2+ min for large datasets | Progress indicator, run in background |
| Instance stopped overnight | Stale data on morning startup | Keep instance running, or quick catch-up sync |
| No offline access | Can't work without connection | Out of scope (cloud-first design) |
| Triage misclassification | Item marked 'keep' should be 'act' | `/item mark` override exists, but discoverable? |

### 🔍 Questions Raised

1. **Context save granularity:** Currently saves on explicit pause/switch. Should there be auto-save every N minutes for crash recovery?

2. **Triage accuracy:** What if triage marks something as 'keep' that should be 'act'? Is the override flow (`/item mark`) discoverable enough?

3. **New source friction:** The Ramp integration took 1.5 hours. Could it be faster with better templates or a wizard?

4. **Cross-zone search:** Currently defaults to current zone. Is that right, or should `/search` always be global with explicit zone filter?

5. **Standup/meeting interrupts:** The pause/resume worked well. What about recurring meetings — should there be a "meeting mode" that auto-pauses?

6. **Dashboard freshness:** What if pollers failed overnight? Should dashboard show "last successful sync" timestamps prominently?
