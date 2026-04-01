// Windmill Script: Aikido Get Issue Detail (Read-Only)
// Investigation tool — gets detailed information about a single Aikido issue.
//
// Requires: f/investigate/aikido_client_id, f/investigate/aikido_client_secret

import { aikidoFetch } from "./aikido_helper.ts";

export async function main(
  issue_id: string,
) {
  if (!issue_id) {
    return { error: "issue_id is required" };
  }

  try {
    const data = await aikidoFetch(`/issues/${issue_id}`);

    return {
      id: data.id,
      title: data.title,
      description: data.description,
      severity: data.severity,
      severity_score: data.severity_score,
      type: data.type,
      status: data.status || data.group_status,
      how_to_fix: data.how_to_fix,
      time_to_fix_minutes: data.time_to_fix_minutes,
      locations: data.locations,
      related_cves: data.related_cve_ids || data.cve_ids,
      first_detected: data.first_detected_at || data.created_at,
      last_seen: data.last_seen_at || data.updated_at,
      raw: data,
    };
  } catch (e) {
    return { error: String(e) };
  }
}
