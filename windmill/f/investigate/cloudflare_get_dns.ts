// Windmill Script: Cloudflare Get DNS Records
// Investigation tool — retrieves DNS records for a zone.

import { cloudflareFetch } from "./cloudflare_helper.ts";

export async function main(
  zone_id: string,
  search?: string,
  type?: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV" | "CAA" | "SPF",
  limit: number = 100,
) {
  if (!zone_id) {
    return { error: "zone_id is required. Use cloudflare_list_zones to find zone IDs." };
  }

  const params: Record<string, string | number | boolean | undefined> = {
    per_page: limit,
    order: "type",
    direction: "asc",
  };

  if (search) params.name = search;
  if (type) params.type = type;

  const data = await cloudflareFetch(`/zones/${zone_id}/dns_records`, { params });

  const records = (data.result || []).map((r: any) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    content: r.content,
    proxied: r.proxied,
    ttl: r.ttl,
    priority: r.priority,
    created_on: r.created_on,
    modified_on: r.modified_on,
  }));

  return {
    zone_id,
    total: data.result_info?.total_count ?? records.length,
    returned: records.length,
    records,
  };
}
