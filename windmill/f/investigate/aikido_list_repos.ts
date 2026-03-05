// Windmill Script: Aikido List Repositories (Read-Only)
// Investigation tool — lists code repositories connected to Aikido.
//
// Requires: f/investigate/aikido_client_id, f/investigate/aikido_client_secret

import { aikidoFetch } from "./aikido_helper.ts";

export async function main(
  search?: string,
  limit: number = 50,
) {
  try {
    const data = await aikidoFetch("/repositories/code", {
      params: {
        ...(search && { search }),
        per_page: limit,
      },
    });

    const repos = data?.repositories || data || [];
    const items = Array.isArray(repos) ? repos : [];

    return {
      count: items.length,
      repositories: items.slice(0, limit).map((r: any) => ({
        id: r.id,
        name: r.name,
        provider: r.provider,
        url: r.url || r.html_url,
        is_active: r.is_active,
        last_scan: r.last_scan_at || r.last_scanned_at,
        open_issues: r.open_issue_count || r.nr_of_open_issues,
        language: r.language,
      })),
    };
  } catch (e) {
    return { error: String(e) };
  }
}
