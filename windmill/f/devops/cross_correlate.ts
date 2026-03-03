// DEPRECATED: 2026-03-03
// Entity co-occurrence graph builder that wrote to knowledge.jsonl.
// Superseded by cache_lib.ts SQLite entity_index (queryEntity) which
// investigate.ts already uses for cross-source correlation.
// Problems: 4 of 6 input log sources were never populated, output
// (knowledge.jsonl) had zero consumers, and co-occurrence != relevance.
//
// Safe to delete after disabling the schedule in Windmill.

export async function main(
  lookback_days: number = 7,
  min_co_occurrences: number = 2,
  dry_run: boolean = false,
) {
  return {
    error: "DEPRECATED: cross_correlate is no longer active. Entity correlation is handled by cache_lib.queryEntity() in investigate.ts.",
    deprecated_at: "2026-03-03",
  };
}
