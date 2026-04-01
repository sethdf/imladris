---
sidebar_position: 4
---

# Investigate-First Pipeline Redesign

## Context

The current `process_actionable.ts` creates SDP Tasks for every QUEUE/NOTIFY item, then optionally investigates. Problem: most investigations return empty results (probes_run: 0, entities_found: 0) because only the AWS Steampipe plugin is installed. Creating tasks with no actionable context produces noise. Seth's directive: **investigate first, only create tasks when real findings exist, and never lose an item**.

Items blocked by missing credentials (e.g., M365 plugin not installed) should wait in a "waiting for context" state and retry on each run. If context needs can't be determined, create a task anyway — nothing should ever be left and lost.

## Files to Modify

1. **`f/devops/cache_lib.ts`** — Add investigation tracking columns + query functions
2. **`f/devops/process_actionable.ts`** — Rewrite to three-phase investigate-first pipeline
3. **`f/devops/process_actionable.script.yaml`** — Add new parameters

`f/devops/investigate.ts` is NOT modified — it already returns `needs_credential` and `entities_found` which we use for the quality gate.

## Plan

### 1. Schema Changes (`cache_lib.ts`)

Add 5 columns to `triage_results` via ALTER TABLE migrations (same pattern as `task_id`):

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `investigation_status` | TEXT | `null` | `null` (uninvestigated), `substantial`, `waiting_context`, `empty`, `error`, `escalated` |
| `investigation_result` | TEXT | `null` | JSON blob of investigation output |
| `waiting_context_reason` | TEXT | `null` | JSON array of `needs_credential` entries from investigate.ts |
| `investigation_attempts` | INTEGER | `0` | Retry counter |
| `last_investigated_at` | INTEGER | `null` | Unix epoch of last investigation attempt |

Add index: `idx_triage_results_inv_status ON triage_results(investigation_status)`.

### 2. New Cache Functions (`cache_lib.ts`)

Add these exported functions (follow existing patterns — getDb(), init(), try/catch/close):

- **`getUninvestigatedActionable(limit, priorityFilter?)`** — Items where `action IN ('QUEUE','NOTIFY') AND domain='work' AND investigation_status IS NULL`, ordered by urgency.
- **`getWaitingContextItems(retryAfterSeconds, maxAttempts, limit)`** — Items where `investigation_status='waiting_context' AND investigation_attempts < maxAttempts AND (last_investigated_at IS NULL OR last_investigated_at < cutoff)`.
- **`getInvestigatedReadyForTask(limit)`** — Items where `investigation_status='substantial' AND task_id IS NULL`, grouped by dedup_hash (one per hash).
- **`getStaleItems(maxAttempts, limit)`** — Items where `investigation_status IN ('waiting_context','empty','error') AND investigation_attempts >= maxAttempts AND task_id IS NULL`.
- **`updateInvestigationStatus(dedupHash, status, result?, waitingReason?, attempts?)`** — Update investigation columns for all rows matching dedup_hash. Increments `investigation_attempts`, sets `last_investigated_at = now`.

### 3. Quality Gate Function (`process_actionable.ts`)

New function `assessInvestigationQuality(result)` that classifies investigation output:

```
function assessInvestigationQuality(result): { quality: string, reason: string }
```

Decision logic using fields from `investigate.ts` return value:

| Quality | Condition |
|---------|-----------|
| **`substantial`** | `probes_successful > 0` OR `entities_found > 0 AND diagnosis.confidence !== 'low'` |
| **`waiting_context`** | `needs_credential.length > 0` (investigation blocked by missing plugins/credentials) |
| **`empty`** | `entities_found === 0` AND `needs_credential.length === 0` (nothing to investigate, no missing context) |
| **`error`** | Investigation job failed or timed out |

Priority: error > waiting_context > substantial > empty (check in this order).

### 4. Three-Phase Pipeline (`process_actionable.ts`)

Rewrite `main()` with three sequential phases:

**Phase 1: INVESTIGATE** — Run investigations on uninvestigated items + retry-eligible waiting_context items.

1. Fetch uninvestigated items via `getUninvestigatedActionable()`.
2. Fetch retry-eligible waiting_context items via `getWaitingContextItems(retryAfterSeconds, maxAttempts)`.
3. Combine and cap at `max_items`.
4. For each item: run `runInvestigation()`, assess quality, call `updateInvestigationStatus()`.
5. For `waiting_context` items: log which credentials are needed.

**Phase 2: CREATE TASKS** — Create SDP Tasks for items with substantial findings.

1. Fetch items via `getInvestigatedReadyForTask()`.
2. For each: create SDP Task (existing `createSdpTask()`), attach investigation worklog (existing `addTaskNote()`), update `task_id` via `updateTaskId()`.
3. Task description includes investigation summary. Worklog contains full investigation report.

**Phase 3: ESCALATE STALE** — Create tasks for items that exhausted retry attempts.

1. Fetch items via `getStaleItems(maxAttempts)`.
2. For each: create SDP Task with description noting the investigation gap.
3. For `waiting_context` items: include credential setup instructions in the task description (referencing BWS).
4. For `empty` items: note that no entities could be extracted.
5. Update `investigation_status = 'escalated'` and set `task_id`.

This ensures **nothing is ever lost** — items either get a task with findings, or get a task explaining why investigation couldn't produce findings.

### 5. Updated Parameters (`process_actionable.script.yaml`)

Add to schema:

- `retry_interval_hours` (number, default: 6) — Hours between retry attempts for waiting_context items
- `max_retry_attempts` (number, default: 5) — Max investigation attempts before escalation

Keep existing: `max_items`, `priority_filter`, `skip_investigation`, `dry_run`, `delay_ms`.

### 6. Return Value

Updated return shape:
```json
{
  "phase1_investigated": 5,
  "phase1_waiting_context": 2,
  "phase1_substantial": 3,
  "phase1_empty": 0,
  "phase1_errors": 0,
  "phase2_tasks_created": 3,
  "phase2_notes_added": 3,
  "phase3_escalated": 1,
  "errors": 0,
  "duration_s": 45,
  "results": [...]
}
```

## Key Design Decisions

- **Dedup grouping stays**: Process by unique `dedup_hash`, update all rows matching hash.
- **`investigate.ts` unchanged**: It already returns `needs_credential` array and probe counts — we just gate on them.
- **Inlined SDP calls stay**: Avoids single-worker deadlock (Decision from prior session).
- **Async investigation stays**: Submit job + poll via `get_result_maybe` (avoids worker deadlock).
- **BWS messaging**: Escalated waiting_context tasks include text like "Configure [plugin] credentials in Bitwarden Secrets (BWS) and install the Steampipe plugin."

## Verification

1. `wmill sync push` — push changes to Windmill
2. Restart workers — `docker restart imladris-windmill_worker-1 imladris-windmill_worker_2-1`
3. Run dry_run — `process_actionable(dry_run=true)` to preview phase breakdown
4. Run live with max_items=3 — verify Phase 1 investigates, Phase 2 creates tasks only for substantial, Phase 3 escalates stale
5. Verify waiting_context items are NOT permanently skipped — re-run should retry them
6. Verify escalated items have descriptive task descriptions with credential setup instructions
7. Check triage_results table — `investigation_status` populated, `investigation_attempts` incremented
