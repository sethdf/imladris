// Windmill Script: Aikido Get Repository Detail (Read-Only)
// Investigation tool — gets detailed info about a single Aikido code repository.
//
// Requires: f/investigate/aikido_client_id, f/investigate/aikido_client_secret

import { aikidoFetch } from "./aikido_helper.ts";

export async function main(
  repo_id: string,
) {
  if (!repo_id) {
    return { error: "repo_id is required" };
  }

  try {
    const data = await aikidoFetch(`/repositories/code/${repo_id}`);

    return {
      id: data.id,
      name: data.name,
      provider: data.provider,
      url: data.url || data.html_url,
      is_active: data.is_active,
      last_scan: data.last_scan_at || data.last_scanned_at,
      open_issues: data.open_issue_count || data.nr_of_open_issues,
      language: data.language,
      branches: data.branches,
      default_branch: data.default_branch,
      raw: data,
    };
  } catch (e) {
    return { error: String(e) };
  }
}
