// Windmill Script: Aikido List Runtime Threats (Read-Only)
// Investigation tool — lists runtime threats detected by Aikido Zen firewall.
//
// Requires: f/investigate/aikido_client_id, f/investigate/aikido_client_secret

import { aikidoFetch } from "./aikido_helper.ts";

export async function main(
  limit: number = 50,
) {
  try {
    const data = await aikidoFetch("/firewall/threats", {
      params: { per_page: limit },
    });

    const threats = data?.threats || data || [];
    const items = Array.isArray(threats) ? threats : [];

    return {
      count: items.length,
      threats: items.slice(0, limit).map((t: any) => ({
        id: t.id,
        type: t.type,
        severity: t.severity,
        source_ip: t.source_ip || t.ip,
        path: t.path || t.url,
        method: t.method,
        app: t.app_name || t.app,
        blocked: t.blocked,
        detected_at: t.detected_at || t.created_at,
      })),
    };
  } catch (e) {
    return { error: String(e) };
  }
}
