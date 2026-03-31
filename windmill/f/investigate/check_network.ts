// Windmill Script: Check Network (Read-Only)
// Investigation tool — DNS lookups, reverse DNS, and TLS certificate checks.
// Useful for investigating domain ownership, IP attribution, and certificate validity.
// Migrated from Node.js native DNS/TLS to Steampipe net plugin (read-only by enforcement).

import { steampipeQuery } from "./steampipe_helper.ts";

export async function main(
  action: "dns_lookup" | "reverse_dns" | "check_certificate" | "mx_lookup" | "txt_lookup",
  target: string,
) {
  if (!target) return { error: "target is required — provide a hostname or IP address" };

  switch (action) {
    case "dns_lookup": {
      const rows = await steampipeQuery(`
        SELECT domain, type, ip, ttl
        FROM net.net_dns_record
        WHERE domain = $1 AND type IN ('A', 'AAAA')
        ORDER BY type, ip
      `, [target]);

      const ipv4 = rows.filter((r: any) => r.type === "A").map((r: any) => r.ip);
      const ipv6 = rows.filter((r: any) => r.type === "AAAA").map((r: any) => r.ip);

      return { action: "dns_lookup", hostname: target, ipv4, ipv6 };
    }

    case "reverse_dns": {
      const rows = await steampipeQuery(`
        SELECT domain, type, target AS hostname, ttl
        FROM net.net_dns_record
        WHERE domain = $1 AND type = 'PTR'
      `, [target]);

      return {
        action: "reverse_dns",
        ip: target,
        hostnames: rows.map((r: any) => r.hostname).filter(Boolean),
      };
    }

    case "check_certificate": {
      const rows = await steampipeQuery(`
        SELECT
          domain,
          subject,
          issuer,
          not_before      AS valid_from,
          not_after       AS valid_to,
          serial_number   AS serial,
          sha256_fingerprint AS fingerprint,
          dns_names       AS alt_names,
          is_valid_at
        FROM net.net_certificate
        WHERE domain = $1
      `, [target]);

      if (!rows.length) return { action: "check_certificate", hostname: target, error: "No certificate data returned" };
      const cert = rows[0];

      return {
        action:      "check_certificate",
        hostname:    target,
        subject:     cert.subject,
        issuer:      cert.issuer,
        valid_from:  cert.valid_from,
        valid_to:    cert.valid_to,
        serial:      cert.serial,
        fingerprint: cert.fingerprint,
        alt_names:   cert.alt_names || [],
        authorized:  cert.is_valid_at,
      };
    }

    case "mx_lookup": {
      const rows = await steampipeQuery(`
        SELECT domain, type, target AS exchange, priority, ttl
        FROM net.net_dns_record
        WHERE domain = $1 AND type = 'MX'
        ORDER BY priority ASC
      `, [target]);

      return {
        action: "mx_lookup",
        hostname: target,
        mx_records: rows.map((r: any) => ({ exchange: r.exchange, priority: r.priority })),
      };
    }

    case "txt_lookup": {
      const rows = await steampipeQuery(`
        SELECT domain, type, value, ttl
        FROM net.net_dns_record
        WHERE domain = $1 AND type = 'TXT'
      `, [target]);

      return {
        action: "txt_lookup",
        hostname: target,
        txt_records: rows.map((r: any) => r.value).filter(Boolean),
      };
    }
  }
}
