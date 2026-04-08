# Personal Domain Pack

Personal life domain for the imladris triage pipeline.

## Status: Stub (Phase 2f)

This domain pack is ready for implementation. The directory structure exists,
the `personal` Postgres schema will be created by Phase 2d.

## First Slice: Telegram

The initial implementation ingests personal Telegram messages into the personal
triage cache. Scoped to explicit connections only — no ambient expansion.

### Sources (planned)
- `batch_triage_telegram_personal.ts` — Personal Telegram ingestion (scoped channels)
- Personal email ingestion (separate M365 account or Gmail)
- Calendar event ingestion

### Actions (planned)
- Personal task creation (not SDP — local task tracker or Notion)
- Personal notification routing

### Infra (planned)
- Personal credential management (separate from work BWS)

## Credentials Required

TBD — will use BWS with `personal-` prefix keys.

## Ingestion Boundary

**Explicit only.** Only ingest from channels/contacts explicitly configured.
No ambient scanning of all messages. The boundary is defined in a config
file, not discovered at runtime.

## Data Isolation

All personal triage data lives in the `personal` Postgres schema.
Work data in `work` schema cannot query personal, and vice versa.
Cross-domain insights must be explicitly graduated to `shared` schema.
