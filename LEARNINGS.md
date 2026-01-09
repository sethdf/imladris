# DevBox Session Learnings

Captured from session on 2026-01-08.

---

## Claude Code Architecture

### Session Storage

```
~/.claude/
├── projects/<path>/          # Session transcripts per project
│   └── <session-id>.jsonl    # Full conversation logs (append-only)
├── history.jsonl             # Command/input history (short entries)
├── history/                  # PAI structured history (see below)
├── skills/                   # Skill definitions
├── hooks/                    # Hook scripts
└── settings.json             # Global settings
```

### What Defines a "Project"

A project = the working directory where you launch `claude`.

```bash
cd ~/current/box && claude    # Project: -home-sfoley-current-box
cd ~/work/tickets && claude   # Project: -home-sfoley-work-tickets
```

Path becomes folder name (slashes → dashes). Each project gets:
- Own session history in `~/.claude/projects/<path>/`
- Can have local `.claude/` directory with project-specific settings
- Auto-loads `CLAUDE.md` if present

### Memory and Compaction

**Key insight:** "Memory" is literal RAM on local machine, not disk or cloud.

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code CLI (local)                                │
│                                                         │
│  RAM: Live conversation context                         │
│  Disk: JSONL transcript (append-only log)               │
│                                                         │
│  When context fills up:                                 │
│  1. Detects context window getting full                 │
│  2. Sends older messages to Claude for summarization    │
│  3. Replaces old messages with summary in RAM           │
│  4. JSONL on disk keeps full original                   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Claude API (cloud) - STATELESS                         │
│                                                         │
│  - Receives whatever context is sent                    │
│  - No memory between API calls                          │
│  - Does summarization when asked                        │
└─────────────────────────────────────────────────────────┘
```

**Implications:**
- Compaction happens locally, summarization in cloud
- JSONL files have full history even after compaction
- If Claude Code crashes before writing, data in RAM is lost
- `/resume` reads JSONL from disk back into RAM

---

## PAI (Personal AI Infrastructure)

### Architecture

PAI is built on Claude Code's hook system. It adds:
- Structured history (learnings, decisions, research)
- Skills (markdown files loaded into context)
- Hooks (intercept events, persist important data)

### PAI History vs Claude Code Transcripts

| Aspect | Claude Code Raw | PAI Structured |
|--------|-----------------|----------------|
| Location | `~/.claude/projects/*/` | `~/.claude/history/` |
| Content | Full JSONL transcripts | Extracted learnings |
| Detail | Everything (tools, errors, thinking) | Curated summaries |
| Size | Large | Small |
| Resume | Yes | No |
| Cross-session | Manual grep | Designed for it |

### PAI History Structure

```
~/.claude/history/
├── sessions/       # Session summaries
├── learnings/      # Extracted insights
├── decisions/      # Choices made
├── research/       # Research notes
├── execution/      # Execution logs
└── raw-outputs/    # Raw outputs
```

### How PAI Prevents Memory Loss

Hooks intercept conversation events and write to disk:

```
Conversation → Hook fires → Extract important bits → Write to history/
```

This persists information before compaction loses it from context.

---

## Gemini CLI Comparison

Google's Gemini CLI has nearly identical architecture to Claude Code.

### Hook System Comparison

| Gemini CLI | Claude Code |
|------------|-------------|
| `SessionStart` / `SessionEnd` | `SessionStart` / `SessionEnd` |
| `BeforeTool` / `AfterTool` | `PreToolUse` / `PostToolUse` |
| `BeforeAgent` / `AfterAgent` | `UserPromptSubmit` / `Stop` |
| `PreCompress` | `PreCompact` |
| `Notification` | `Notification` |

### Extension System

Both use similar patterns:
- Manifest files (`gemini-extension.json` vs `plugin.json`)
- Custom commands (slash commands)
- MCP server integration
- Context files (`GEMINI.md` vs `CLAUDE.md`)

### PAI Portability

PAI concepts could work with Gemini CLI:
- Skills (markdown) → Easy port
- Hooks → Medium (event name changes)
- History structure → Easy (just files)
- CORE identity → Easy (different context file)

The architectures have converged on similar patterns.

---

## DevBox Architecture

### Simplified Setup (Current)

```
/home/ubuntu/
├── work → /data/work/        # Work files (symlink)
├── home → /data/home/        # Home files (symlink)
├── .claude/                  # PAI (unified, default location)
│   ├── history/
│   ├── hooks/
│   └── skills/
└── bin/                      # Installed scripts
```

### Work/Home Separation

Directories are for file organization only. PAI is unified.

| Variable | Work | Home |
|----------|------|------|
| `CONTEXT` | work | home |
| `GHQ_ROOT` | /data/work/repos | /data/home/repos |
| `SDP_TICKETS_DIR` | /data/work/tickets | (not set) |

PAI uses default `~/.claude` everywhere.

### Context-Aware Skills

Skills can check `$CONTEXT` environment variable:

```markdown
# ServiceDesk Plus Skill

> **Context:** Work only. Requires `CONTEXT=work`.
```

Claude reads this and self-enforces.

---

## Nix + home-manager

### Why Nix

Replaced 700+ line bash script with declarative config:
- Reproducible builds
- Easy rollback (`home-manager rollback`)
- Atomic updates
- Single source of truth

### Structure

```
nix/
├── flake.nix     # Inputs (nixpkgs, home-manager)
└── home.nix      # All packages and config
```

### Key Commands

```bash
# Apply changes
home-manager switch --flake .#ubuntu

# Rollback
home-manager rollback

# List generations
home-manager generations
```

---

## ServiceDesk Plus Workflow

### Notes vs Replies

| Type | Visibility | Use For |
|------|------------|---------|
| `note` | Technicians only | Root cause, things tried |
| `reply` | Requester sees | Status updates, resolutions |

### Workflow

```bash
sdp-work start 12345    # Create workspace
cd ~/work/tickets/SDP-12345
vim notes.md            # Add findings
sdp-work sync           # Push notes (private)
sdp-work reply          # Draft response
sdp-work send-reply     # Send to requester (public)
sdp-work done           # Final sync, update status
```

### Directory Structure

```
~/work/tickets/SDP-12345/
├── .ticket.json        # Cached metadata
├── notes.md            # Private notes → SDP
├── replies/            # Public replies → SDP
└── files/              # Attachments
```

---

## Key Decisions Made

1. **Unified PAI** - Single `~/.claude` instead of per-context
2. **Files only separation** - Work/home for repos and files, not PAI
3. **Context via direnv** - `CONTEXT`, `GHQ_ROOT` auto-switch on `cd`
4. **Skill context awareness** - Skills check `$CONTEXT` themselves
5. **Nix over bash** - Declarative, reproducible, rollback-able

---

## Open Questions / Future Work

1. **Session sync scope** - Sync just PAI history or raw transcripts too?
2. **Cross-session search** - Semantic search across history?
3. **PAI for Gemini** - Port skills/hooks to Gemini CLI?
4. **Auto-commit** - Auto-push session history to git?
