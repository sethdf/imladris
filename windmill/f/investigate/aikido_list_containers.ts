// Windmill Script: Aikido List Containers (Read-Only)
// Investigation tool — lists container images and their vulnerability status in Aikido.
//
// Requires: f/investigate/aikido_client_id, f/investigate/aikido_client_secret

import { aikidoFetch } from "./aikido_helper.ts";

export async function main(
  search?: string,
  limit: number = 50,
) {
  try {
    const data = await aikidoFetch("/repositories/container", {
      params: {
        ...(search && { search }),
        per_page: limit,
      },
    });

    const containers = data?.repositories || data?.containers || data || [];
    const items = Array.isArray(containers) ? containers : [];

    return {
      count: items.length,
      containers: items.slice(0, limit).map((c: any) => ({
        id: c.id,
        name: c.name,
        registry: c.registry || c.provider,
        tag: c.tag || c.latest_tag,
        last_scan: c.last_scan_at,
        open_issues: c.open_issue_count || c.nr_of_open_issues,
        status: c.status,
      })),
    };
  } catch (e) {
    return { error: String(e) };
  }
}
