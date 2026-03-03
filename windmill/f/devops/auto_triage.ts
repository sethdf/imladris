// DEPRECATED: 2026-03-03
// Superseded by batch_triage_emails.ts (L1 dedup + rules + AI classify),
// triage_pipeline.ts (single-item classify + investigate), and investigate.ts
// (entity correlation + cross-source context). This script had no callers
// and its entity correlation feature is fully covered by investigate.ts.
//
// Safe to delete after confirming no Windmill triggers reference this path.

export async function main(
  source: string,
  event_type: string,
  payload: string,
  dry_run: boolean = false,
) {
  return {
    error: "DEPRECATED: auto_triage is no longer active. Use batch_triage_emails or triage_pipeline instead.",
    source,
    event_type,
    deprecated_at: "2026-03-03",
  };
}
