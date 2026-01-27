# Intake System

Universal intake system for personal information triage. A local RAG for messages from all sources.

## Quick Start

```bash
# Initialize database
bun run cli.ts init

# Sync from sources
bun run cli.ts sync telegram
bun run cli.ts sync signal
bun run cli.ts sync email-ms365
bun run cli.ts sync email-gmail
bun run cli.ts sync calendar-ms365
bun run cli.ts sync all

# Query items
bun run cli.ts query -z work -n 10
bun run cli.ts query --untriaged

# Show statistics
bun run cli.ts stats
bun run cli.ts stats work

# Run triage
bun run cli.ts triage list
bun run cli.ts triage run

# Manage embeddings
bun run cli.ts embed backfill
bun run cli.ts embed test "your text here"
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         INTAKE SYSTEM                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐            │
│  │  Telegram  │ │   Signal   │ │   Email    │ │  Calendar  │  Sources   │
│  │  Adapter   │ │  Adapter   │ │ MS365/Gmail│ │   MS365    │            │
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘            │
│         │                   │                   │                        │
│         └───────────────────┴───────────────────┘                        │
│                             │                                            │
│                             ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    SQLite Database                                │   │
│  │  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌───────────┐           │   │
│  │  │ intake  │  │ messages │  │ triage  │  │ sync_state│           │   │
│  │  └─────────┘  └──────────┘  └─────────┘  └───────────┘           │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                             │                                            │
│                             ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                      TRIAGE ENGINE                                │   │
│  │                                                                    │   │
│  │  1. Enrichment (chrono-node, compromise)                          │   │
│  │     ↓                                                              │   │
│  │  2. Deterministic Rules (json-rules-engine)                       │   │
│  │     ↓                                                              │   │
│  │  3. Similarity Search (Transformers.js embeddings)                │   │
│  │     ↓                                                              │   │
│  │  4. AI (only for ambiguous cases)                                 │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Zone Support

The system supports two zones: `work` and `home`. Set via:

```bash
# Environment variable
export ZONE=work
bun run cli.ts query

# Or per-command
bun run cli.ts query -z home
```

## Thread-First Model

Chat conversations and email threads are triaged as **conversations**, not individual messages:

- Each chat/group or email thread becomes one intake item
- Individual messages are stored in the `messages` table
- Context is built from message history for triage
- Conversations are updated on each new message

**Email specifics:**
- MS365: Groups by `ConversationId`
- Gmail: Groups by `threadId`
- Calendar events are treated as individual items (not threaded)

## Embeddings

Local embeddings using [Transformers.js](https://github.com/huggingface/transformers.js):

- **Model:** Xenova/all-MiniLM-L6-v2
- **Dimensions:** 384
- **Download:** ~25MB on first use (cached in `~/.cache/huggingface`)

```bash
# Backfill embeddings for existing items
bun run cli.ts embed backfill

# Test embedding
bun run cli.ts embed test "hello world"
```

## Triage Classification

Multi-layer classification for maximum determinism:

| Layer | Technology | Purpose |
|-------|------------|---------|
| 1. Enrichment | chrono-node, compromise | Extract dates, people, orgs |
| 2. Rules | json-rules-engine | VIP sender, urgent keywords |
| 3. Similarity | Transformers.js | Find similar triaged items |
| 4. AI | Claude API | Only for truly ambiguous |

## Database Location

```
/data/.cache/intake/intake.sqlite
```

Override with `INTAKE_DB` environment variable.

## Systemd Setup

Install the systemd service and timer for automated syncing:

```bash
# Copy service files
sudo cp intake-sync.service /etc/systemd/system/
sudo cp intake-sync.timer /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable intake-sync.timer
sudo systemctl start intake-sync.timer

# Check status
systemctl status intake-sync.timer
systemctl list-timers | grep intake
```

## Development

```bash
# Install dependencies
bun install

# Type check
bunx tsc --noEmit

# Run CLI
bun run cli.ts help
```

## File Structure

```
lib/intake/
├── cli.ts                    # Main CLI entry point
├── package.json              # Dependencies
├── tsconfig.json             # TypeScript config
├── intake-sync.service       # Systemd service
├── intake-sync.timer         # Systemd timer
├── db/
│   ├── database.ts           # SQLite operations
│   ├── schema.sql            # Database schema
│   └── index.ts              # Exports
├── embeddings/
│   ├── pipeline.ts           # Transformers.js embedding
│   └── index.ts              # Exports
├── adapters/
│   ├── base.ts               # Base adapter class
│   ├── telegram.ts           # Telegram Bot API adapter
│   ├── signal.ts             # Signal CLI REST adapter
│   ├── email-ms365.ts        # MS365 email adapter (Graph API)
│   ├── email-gmail.ts        # Gmail adapter (Gmail API)
│   ├── calendar-ms365.ts     # MS365 calendar adapter (Graph API)
│   └── index.ts              # Exports
└── triage/
    ├── rules.ts              # json-rules-engine rules
    ├── entities.ts           # Entity extraction
    ├── similarity.ts         # Similarity search
    └── index.ts              # Exports
```

## Migration from UnifiedInbox

This system replaces the deprecated `UnifiedInbox` skill. See:
`~/repos/github.com/sethdf/curu-skills/Inbox/UnifiedInbox/DEPRECATED.md`

Key differences:
- Database: `/data/.cache/intake/` (not `/data/.cache/unified-inbox/`)
- CLI: `intake` (not `inbox`)
- Built-in triage (no separate InboxRank skill needed)
- Thread-first model for chat
- Zone support baked in

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `INTAKE_DB` | Database path | `/data/.cache/intake/intake.sqlite` |
| `ZONE` | Default zone | `work` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | (from BWS) |
| `TELEGRAM_CHAT_ID` | Allowed chat ID | (from BWS) |
| `SIGNAL_API_URL` | Signal CLI API | `http://127.0.0.1:8080` |
| `SIGNAL_PHONE` | Signal phone number | (from BWS) |
| `MS365_USER` | MS365 user email | (required for email/calendar) |

## Authentication

Email and calendar adapters use `auth-keeper.sh` for authentication:

- **MS365**: Uses PowerShell via `_ak_ms365_cmd` for Graph API access
- **Gmail**: Uses curl with OAuth token from `_ak_google_get_access_token`

Ensure auth-keeper is configured before using email/calendar sync. See `scripts/auth-keeper.sh` for setup.
