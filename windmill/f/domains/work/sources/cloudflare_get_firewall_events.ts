// Windmill Script: Cloudflare Get Firewall Events
// Investigation tool — queries WAF/firewall events for a zone.

import { cloudflareFetch } from "./cloudflare_helper.ts";

export async function main(
  zone_id: string,
  hours: number = 24,
  action?: "block" | "challenge" | "js_challenge" | "managed_challenge" | "allow" | "log" | "bypass",
  limit: number = 50,
) {
  if (!zone_id) {
    return { error: "zone_id is required. Use cloudflare_list_zones to find zone IDs." };
  }

  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  // Use the firewall events analytics API
  const params: Record<string, string | number | boolean | undefined> = {
    per_page: limit,
    since,
    order: "-occurred_at",
  };

  if (action) params.action = action;

  try {
    // Try Security Events API first (newer)
    const data = await cloudflareFetch(`/zones/${zone_id}/security/events`, { params });

    const events = (data.result || []).map((e: any) => ({
      id: e.id,
      action: e.action,
      source: e.source,
      rule_id: e.ruleId,
      rule_message: e.ruleMessage,
      client_ip: e.clientIP,
      client_country: e.clientCountry,
      host: e.host,
      uri: e.uri,
      method: e.method,
      user_agent: e.userAgent?.substring(0, 100),
      occurred_at: e.occurredAt,
    }));

    return {
      zone_id,
      timerange: `${hours} hours`,
      returned: events.length,
      events,
    };
  } catch {
    // Fallback: try firewall/events (older API)
    try {
      const data = await cloudflareFetch(`/zones/${zone_id}/firewall/events`, { params });

      const events = (data.result || []).map((e: any) => ({
        id: e.id,
        action: e.action,
        source: e.source,
        rule_id: e.ruleId,
        client_ip: e.ip,
        host: e.host,
        uri: e.uri,
        method: e.method,
        occurred_at: e.occurredAt,
      }));

      return {
        zone_id,
        timerange: `${hours} hours`,
        returned: events.length,
        api: "firewall/events (legacy)",
        events,
      };
    } catch (e2) {
      return {
        zone_id,
        error: `Firewall events unavailable: ${String(e2).substring(0, 200)}`,
        note: "API token may lack Zone.Firewall Services read permission",
      };
    }
  }
}
