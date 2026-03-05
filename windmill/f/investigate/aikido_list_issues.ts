// Windmill Script: Aikido List Issues (Read-Only)
// Investigation tool — lists open vulnerability/issue groups from Aikido Security.
// Supports filtering by severity, type, and search text.
//
// Requires: f/investigate/aikido_client_id, f/investigate/aikido_client_secret

import { aikidoFetch } from "./aikido_helper.ts";

export async function main(
  severity?: "critical" | "high" | "medium" | "low",
  issue_type?: "open_source" | "leaked_secret" | "cloud" | "sast" | "iac" | "docker_container" | "surface_monitoring" | "malware" | "eol" | "license",
  search?: string,
  limit: number = 50,
) {
  try {
    const data = await aikidoFetch("/open-issue-groups", {
      params: {
        ...(severity && { severity }),
        ...(issue_type && { type: issue_type }),
        ...(search && { search }),
        per_page: limit,
      },
    });

    const groups = data?.groups || data || [];
    const items = Array.isArray(groups) ? groups : [];

    return {
      count: items.length,
      filters: { severity, issue_type, search },
      issues: items.slice(0, limit).map((g: any) => ({
        id: g.id,
        title: g.title || g.name,
        severity: g.severity,
        severity_score: g.severity_score,
        type: g.type,
        issue_count: g.issue_count || g.nr_of_issues,
        first_detected: g.first_detected_at || g.created_at,
        status: g.group_status || g.status,
      })),
    };
  } catch (e) {
    return { error: String(e) };
  }
}
