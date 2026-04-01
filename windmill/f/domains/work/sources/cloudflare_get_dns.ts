// Windmill Script: Cloudflare Get DNS Records
// Investigation tool — retrieves DNS records for a zone.
// Migrated from direct Cloudflare API to Steampipe (read-only by enforcement).

import { steampipeQuery } from "./steampipe_helper.ts";

export async function main(
  zone_id: string,
  search?: string,
  type?: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV" | "CAA" | "SPF",
  limit: number = 100,
) {
  if (!zone_id) {
    return { error: "zone_id is required. Use cloudflare_list_zones to find zone IDs." };
  }

  const conditions: string[] = [];
  const params: any[] = [];

  params.push(zone_id);
  conditions.push(`zone_id = $${params.length}`);

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`name ILIKE $${params.length}`);
  }
  if (type) {
    params.push(type);
    conditions.push(`type = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const rows = await steampipeQuery(`
    SELECT
      id,
      name,
      type,
      content,
      proxied,
      ttl,
      priority,
      created_on,
      modified_on
    FROM cloudflare.cloudflare_dns_record
    ${where}
    ORDER BY type ASC, name ASC
    LIMIT ${limit}
  `, params);

  return {
    zone_id,
    total: rows.length,
    returned: rows.length,
    records: rows,
  };
}
