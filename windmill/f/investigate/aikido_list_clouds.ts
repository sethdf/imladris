// Windmill Script: Aikido List Cloud Accounts (Read-Only)
// Investigation tool — lists cloud accounts (AWS/Azure/GCP) connected to Aikido CSPM.
//
// Requires: f/investigate/aikido_client_id, f/investigate/aikido_client_secret

import { aikidoFetch } from "./aikido_helper.ts";

export async function main(
  cloud_type?: "aws" | "azure" | "gcp",
) {
  try {
    const data = await aikidoFetch("/clouds", {
      params: {
        ...(cloud_type && { type: cloud_type }),
      },
    });

    const clouds = data?.clouds || data || [];
    const items = Array.isArray(clouds) ? clouds : [];

    return {
      count: items.length,
      clouds: items.map((c: any) => ({
        id: c.id,
        name: c.name,
        type: c.type || c.provider,
        account_id: c.account_id || c.external_id,
        status: c.status,
        last_scan: c.last_scan_at,
        issue_count: c.open_issue_count || c.nr_of_open_issues,
      })),
    };
  } catch (e) {
    return { error: String(e) };
  }
}
