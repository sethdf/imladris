// Windmill Script: Re-ingest Dismissed Items
// Resets dismissed triage items back to uninvestigated state so they re-enter the pipeline.
// Idempotent — running twice on the same ID is safe (second run returns 0 changes).

import { reingestItem, isAvailable, init } from "./cache_lib.ts";

export async function main(
  item_ids: number[],
): Promise<{ reingested: number; skipped: number; details: { id: number; result: string }[] }> {
  if (!isAvailable()) {
    return { reingested: 0, skipped: 0, details: [{ id: 0, result: "Cache not available" }] };
  }
  init();

  let reingested = 0;
  let skipped = 0;
  const details: { id: number; result: string }[] = [];

  for (const id of item_ids) {
    const changes = reingestItem(id);
    if (changes > 0) {
      reingested++;
      details.push({ id, result: "reingested" });
      console.log(`[reingest_dismissed] Re-ingested item ${id}`);
    } else {
      skipped++;
      details.push({ id, result: "skipped (not dismissed or not found)" });
      console.log(`[reingest_dismissed] Skipped item ${id} (not dismissed or not found)`);
    }
  }

  return { reingested, skipped, details };
}
