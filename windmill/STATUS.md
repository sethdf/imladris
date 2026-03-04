# Windmill DevOps Pipeline — Status as of 2026-03-04

## Pipeline Overview

**Email/Slack/SDP → Triage → AI Investigation → SDP Task/Comment**

Multi-source automated triage system that ingests alerts from email (M365), Slack threads, and SDP items, classifies them via AI, investigates substantial findings with an agentic investigator (AWS Bedrock Opus), and creates/annotates SDP tasks with rich HTML-formatted results.

## Recent Work (Sessions 2026-03-03 → 2026-03-04)

### 1. Agentic Investigator (`f/devops/agentic_investigator.ts`)
- Multi-round tool-use investigation engine using AWS Bedrock Converse API
- Calls read-only Windmill scripts as tools (16+ investigation tools)
- Structured diagnosis output: severity, confidence, root_cause, evidence, criteria_status
- Integrated into process_actionable Phase 1

### 2. Pipeline Extensions (6 items, all complete)
- **AI task prefix**: `**` prefix on AI-created SDP tasks for visual differentiation
- **SDP ingestion** (`batch_triage_sdp.ts`): Polls SDP requests + tasks, stores in triage_results
- **SDP comment posting**: Investigation results posted back to originating SDP items (notes for requests, worklogs for tasks)
- **Slack thread-as-unit**: Thread replies fetched and concatenated as single triage item
- **Cross-source dedup**: Exact subject match prevents duplicate investigations across sources
- **Phase 2 SDP skip**: SDP-sourced items marked `sdp-native` (already exist in SDP)

### 3. HTML Formatting (complete)
- All SDP output converted from raw markdown to rich HTML with inline CSS
- Task descriptions: HTML tables, severity badges, section headers, risk evaluation
- Worklogs: Full investigation report with colored badges, criteria tables, evidence lists
- HTML safety: `esc()` function escapes all user-derived content
- Verified: SDP task 55354000037424001 — description 3793 chars HTML, worklog 5126 chars HTML

### 4. Auto-Dismiss Daily Summary
- Automatic dismissal of known low-priority patterns (Site24x7 up alerts, etc.)
- Daily summary of dismissed items

## Key Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| `process_actionable.ts` | 3-phase pipeline: investigate → create tasks → escalate | ✅ Deployed |
| `agentic_investigator.ts` | Multi-round AI investigation with tool use | ✅ Deployed |
| `batch_triage_sdp.ts` | SDP request/task ingestion | ✅ Deployed |
| `batch_triage_slack.ts` | Slack thread ingestion | ✅ Deployed |
| `cache_lib.ts` | SQLite triage cache with cross-source dedup | ✅ Deployed |
| `sdp_morning_summary.ts` | Daily SDP summary report | ✅ Deployed |

## Architecture Notes

- **Workers**: 2 default Docker containers × 4 workers = 8 slots
- **Investigation**: Async job submission + polling to avoid single-worker deadlock
- **Cache**: SQLite on NVMe (`/local/cache/triage/index.db`), ephemeral by design
- **SDP API**: Inline HTTP calls (not nested Windmill jobs) to avoid deadlock
- **SDP worklog quirk**: LIST endpoint doesn't return descriptions; individual GET does

## What's Next

- Monitor real investigation runs for quality
- Tune auto-dismiss rules based on false positive rate
- Consider adding SDP request/incident creation from high-severity findings
- Slack ingestion schedule setup
