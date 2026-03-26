// Windmill Script: Rate Investigation Quality
// Seth runs this to rate an investigation's accuracy (1-5).
// Feeds into investigation_feedback table → queried by check_investigation_quality tool.
// This closes the investigation feedback loop.

export async function main(
  dedup_hash: string,
  rating: number,
  misdiagnosis_type: string = "",
  notes: string = "",
): Promise<{
  success: boolean;
  dedup_hash: string;
  rating: number;
  error?: string;
}> {
  if (!dedup_hash) {
    return { success: false, dedup_hash: "", rating, error: "dedup_hash is required" };
  }
  if (rating < 1 || rating > 5) {
    return { success: false, dedup_hash, rating, error: "Rating must be 1-5" };
  }

  let cacheLib: any;
  try {
    cacheLib = await import("./cache_lib.ts");
    cacheLib.init();
  } catch (err: any) {
    return { success: false, dedup_hash, rating, error: `Cache unavailable: ${err.message}` };
  }

  // Look up triage context for domain/alert_type enrichment
  const ctx = cacheLib.getTriageContext?.(dedup_hash) || { domain: "", alert_type: "" };

  const id = cacheLib.storeFeedback({
    dedup_hash,
    rating,
    misdiagnosis_type: misdiagnosis_type || null,
    alert_domain: ctx.domain,
    alert_type: ctx.alert_type,
    notes,
  });

  if (id === null) {
    return { success: false, dedup_hash, rating, error: "Failed to store feedback" };
  }

  console.log(`[rate_investigation] Recorded: ${dedup_hash.slice(0, 12)} = ${rating}/5 (${misdiagnosis_type || "no type"}) domain=${ctx.domain} type=${ctx.alert_type}`);
  return { success: true, dedup_hash, rating };
}
