# Imladris 2.0 - Feature & Function Review

> In-depth analysis of features, gaps, and design decisions.

---

## 1. Workspaces

### What's Defined

| Feature | Status | Notes |
|---------|--------|-------|
| 2 zones (work/home) | ✓ Clear | Physical separation of concerns |
| 5 modes per zone | ✓ Clear | tasks, comms, projects, research, adhoc |
| 11 tmux windows | ✓ Clear | Window 0 = dashboard |
| Zone switching | ✓ Clear | Higher friction, context save |
| Mode switching | ✓ Clear | Lower friction |
| Visual signaling | ✓ Clear | Colors, prompt prefix |
| Status bar | ✓ Clear | Shows context |

### Gaps / Questions

| Issue | Question |
|-------|----------|
| **Window creation** | Are all 11 windows pre-created on startup, or created on demand? |
| **Mode default** | `/work` defaults to comms. Why not tasks? |
| **Window persistence** | If tmux dies, how is state restored? |
| **Pane layout** | Parallel panes mentioned but structure unclear |
| **Window navigation** | How does user switch? Ctrl-b n? Shortcut per mode? |

### Recommendation

Add explicit section on:
- Window lifecycle (creation, persistence, recovery)
- Keyboard shortcuts for navigation
- Pane creation/destruction rules

---

## 2. Datahub

### What's Defined

| Feature | Status | Notes |
|---------|--------|-------|
| Flat file storage | ✓ Clear | Markdown per item |
| SQLite index | ✓ Clear | For queries |
| Directory structure | ✓ Clear | `{zone}/{source}/{id}.md` |
| Item format | ✓ Clear | YAML frontmatter + body |
| Triage (act/keep/delete) | ✓ Clear | AI classification |
| Bidirectional sync | ✓ Clear | For SDP, DevOps, email |
| Conflict handling | ✓ Clear | Write-back queue |

### Gaps / Questions

| Issue | Question |
|-------|----------|
| **Index rebuild** | If SQLite corrupted, how to rebuild from flat files? |
| **Search implementation** | Is search via SQLite FTS, grep, or both? |
| **Large items** | What if email body is 100KB? Truncate? |
| **Binary attachments** | Stored where? Just metadata in datahub? |
| **Sync failure** | If Windmill poller fails, how is user notified? |
| **Queue visibility** | Can user see pending write-back items? |

### Recommendation

Add:
- `datahub rebuild-index` command
- Search implementation details (FTS5?)
- Attachment storage path explicitly
- Queue inspection commands

---

## 3. Commands

### Coverage Analysis

| Category | Commands | Complete? |
|----------|----------|-----------|
| Workspace | `/work`, `/home`, `/status` | ✓ |
| Task | `/task list/show/start/switch/note/log/status/pause/done/close/create` | ✓ |
| Item | `/inbox`, `/item show/mark/done` | Partial |
| Search | `/search` with filters | ✓ |
| Calendar | `/calendar`, `/calendar week/add` | ✓ |
| Communication | `/slack`, `/slack reply` | Partial |
| Attachment | `/attachment list/download` | ✓ |
| Cloud | `/aws`, `/gcp` | ✓ |
| System | `/ops status/failures/run`, `/sync status` | ✓ |
| Tags | `/tag add/remove/list` | ✓ |

### Gaps / Questions

| Command | Issue |
|---------|-------|
| `/inbox` | What's the difference vs `/task list`? |
| `/item` vs `/task` | Confusing overlap. Task = SDP ticket? Item = any datahub entry? |
| `/email` | Missing. How to handle email specifically? |
| `/slack reply` | How does this work with slackdump (read-only export)? |
| `/mode` | Mentioned in day-in-life but not in commands section |
| `/dashboard` | Mentioned but not defined |
| `/task resume` | Mentioned in day-in-life but only `/task pause` defined |

### Recommendation

1. Add `/task resume` to complement `/task pause`
2. Clarify item vs task semantics
3. Add `/email` commands or explain why not needed
4. Add `/mode` command or remove from scenarios
5. Verify `/slack reply` is feasible with slackdump

---

## 4. Authentication

### What's Defined

| Feature | Status | Notes |
|---------|--------|-------|
| BWS bootstrap | ✓ Clear | One root credential |
| Windmill credentials | ✓ Clear | Variables + Resources |
| OAuth auto-refresh | ✓ Clear | Via Windmill resources |
| AWS cross-account | ✓ Clear | STS AssumeRole |
| Secret naming | ✓ Clear | `{zone}-{service}-{item}` |
| Bootstrap chain | ✓ Clear | LUKS → BWS → Windmill |

### Gaps / Questions

| Issue | Question |
|-------|----------|
| **OAuth initial setup** | How does user complete first OAuth flow for MS365/Slack? |
| **Token rotation** | Do we rotate BWS access token? How often? |
| **Credential expiry alert** | How is user warned before something expires? |
| **Service principal setup** | MS365 SP creation not documented |
| **slackdump auth** | Browser-based, expires in 30 days. How automated? |

### Recommendation

Add first-time OAuth flow documentation:
- MS365 service principal creation steps
- Slack slackdump browser auth flow
- Google OAuth consent screen setup

---

## 5. Triage

### What's Defined

| Feature | Status | Notes |
|---------|--------|-------|
| Three states | ✓ Clear | act, keep, delete |
| Claude-based | ✓ Clear | Batch triage via Windmill |
| Override | ✓ Clear | `/item mark` |
| Schedule | ✓ Clear | Every 15 min |

### Gaps / Questions

| Issue | Question |
|-------|----------|
| **Triage prompt** | What's the actual prompt sent to Claude? |
| **Confidence score** | Is there one? How used? |
| **Feedback loop** | If user overrides, does system learn? |
| **Batch size** | How many items per triage call? |
| **Cost** | What's the token/API cost per day? |
| **Triage history** | Can user see why something was classified? |

### Recommendation

Add triage implementation details:
- Prompt template
- Batch sizing strategy
- Cost estimate per day
- Confidence thresholds

---

## 6. Sync

### What's Defined

| Feature | Status | Notes |
|---------|--------|-------|
| Inbound polling | ✓ Clear | Windmill schedules |
| Outbound queue | ✓ Clear | Write-back on change |
| Bidirectional fields | ✓ Clear | Appendix A |
| Conflict resolution | ✓ Clear | External wins |
| Delta sync | ✓ Clear | MS365 delta, Gmail history |

### Gaps / Questions

| Issue | Question |
|-------|----------|
| **Initial sync duration** | 365 days of email = how long? |
| **Progress indicator** | During initial sync, what does user see? |
| **Partial failure** | If MS365 sync fails but Slack succeeds, what state? |
| **Sync order** | Does order matter? Dependencies? |
| **Backpressure** | If datahub can't keep up, what happens? |

### Recommendation

Add:
- Initial sync progress UI
- Partial failure handling
- Sync dependency graph (if any)

---

## 7. Windmill Integration

### What's Defined

| Feature | Status | Notes |
|---------|--------|-------|
| Native deployment | ✓ Clear | Nix + systemd |
| Script language | ✓ Clear | TS default, Python when needed |
| Folder structure | ✓ Clear | `f/{module}/` |
| Credential access | ✓ Clear | Variables + Resources |
| Scheduling | ✓ Clear | All cron in Windmill |
| Interactive pattern | ✓ Clear | Get creds, then direct calls |
| OpenAPI codegen | ✓ Clear | Scaffold, then consolidate |

### Gaps / Questions

| Issue | Question |
|-------|----------|
| **Windmill UI access** | Is it exposed? On what port? Auth? |
| **Script versioning** | How are Windmill scripts version-controlled? |
| **Rollback** | If a script breaks, how to rollback? |
| **Monitoring** | Beyond Windmill UI, any external monitoring? |
| **Resource limits** | Memory/CPU limits per script? |

### Recommendation

Add:
- Windmill UI access details (port, auth)
- Script git sync setup
- Monitoring/alerting integration

---

## 8. Infrastructure

### What's Defined

| Feature | Status | Notes |
|---------|--------|-------|
| Terraform | ✓ Clear | EC2 + EBS + VPC |
| Nix/home-manager | ✓ Clear | Declarative config |
| LUKS encryption | ✓ Clear | MFA (keyfile + passphrase) |
| Tailscale access | ✓ Clear | No public ports |
| Backup strategy | ✓ Clear | Snapshots + S3 |
| Storage layout | ✓ Clear | Root + Data volumes |

### Gaps / Questions

| Issue | Question |
|-------|----------|
| **Instance stop/start** | Data persists, but what about running services? |
| **Cost estimate** | Monthly cost for m7g.xlarge + storage? |
| **Scaling** | If 100GB fills up, how to expand? |
| **Disaster recovery** | Full restore procedure from S3? |
| **Multi-region** | Any consideration for region failure? |

### Recommendation

Add:
- Cost estimate table
- Volume expansion procedure
- Full DR procedure

---

## 9. Skills (Curu/PAI)

### What's Defined

| Feature | Status | Notes |
|---------|--------|-------|
| Skill-per-module | ✓ Clear | Thin routing to Windmill |
| Skill template | ✓ Clear | ~20 lines |
| Available skills | ✓ Clear | SDP, MS365, Slack, AWS, etc. |

### Gaps / Questions

| Issue | Question |
|-------|----------|
| **Skill loading** | How does Claude Code load skills? |
| **Skill discovery** | Does Claude know what skills exist? |
| **Skill testing** | How to test a skill works? |
| **Skill conflicts** | What if two skills handle same intent? |

### Recommendation

Add:
- Skill loading mechanism
- Skill testing procedure

---

## 10. Chat Gateway

### What's Defined

| Feature | Status | Notes |
|---------|--------|-------|
| Telegram bridge | ✓ Clear | Bot → tmux |
| Session management | ✓ Clear | /sessions, /switch |
| Command prefix | ✓ Clear | /c for Claude |
| Response detection | ✓ Clear | Polling tmux capture |
| Security | ✓ Clear | Allowlist |

### Gaps / Questions

| Issue | Question |
|-------|----------|
| **Latency** | 2-3s mentioned. Acceptable? |
| **Message length** | Telegram has 4096 char limit. Long responses? |
| **File sharing** | Can you send files via chat? |
| **Error handling** | If tmux session dies, what does user see? |

### Recommendation

Consider:
- Response chunking for long messages
- Explicit error messages for session issues

---

## Summary: Critical Gaps

| Priority | Gap | Impact |
|----------|-----|--------|
| **High** | `/task resume` not defined | Day-in-life scenario broken |
| **High** | Item vs Task semantics unclear | User confusion |
| **High** | OAuth initial setup missing | Can't complete first-time setup |
| **Medium** | Triage prompt not specified | Can't implement |
| **Medium** | Search implementation unclear | Can't implement |
| **Medium** | Windmill UI access undefined | Ops blind spot |
| **Low** | Cost estimates missing | Planning difficulty |
| **Low** | Keyboard shortcuts missing | UX gap |

---

## Summary: Strong Points

| Area | Strength |
|------|----------|
| **Principles** | 12 well-articulated guiding principles |
| **Architecture** | Clear separation of concerns (host/AI, work/home) |
| **Windmill** | Comprehensive integration, good patterns |
| **Auth** | Clean bootstrap chain, no manual credential handling |
| **Sync** | Bidirectional sync well-specified |
| **OpenAPI codegen** | Smart scaffold-then-consolidate pattern |

---

## Next Steps

1. Add missing commands (`/task resume`, `/mode`, clarify `/item` vs `/task`)
2. Document OAuth initial setup flows
3. Specify triage prompt template
4. Add Windmill UI access details
5. Add cost estimates
