// Windmill Script: Query Vendors (Read-Only)
// Investigation tool — searches the vendor inventory (~280 vendors).
// Ports query_vendors logic from mcp_server.ts.

import { existsSync, readFileSync } from "fs";

const VENDOR_JSON = process.env.VENDOR_JSON ||
  `${process.env.HOME}/.claude/MEMORY/WORK/vendor-inventory/vendors.json`;

function loadVendors(): any[] {
  try {
    if (!existsSync(VENDOR_JSON)) return [];
    const data = JSON.parse(readFileSync(VENDOR_JSON, "utf-8"));
    if (Array.isArray(data)) return data;
    if (data?.vendors && Array.isArray(data.vendors)) return data.vendors;
    return [];
  } catch {
    return [];
  }
}

export async function main(
  action: "search" | "list" | "stats" = "search",
  query?: string,
  criticality?: "High" | "Med" | "Low",
  has_login?: boolean,
  limit: number = 20,
  offset: number = 0,
) {
  const vendors = loadVendors();
  if (!vendors.length) {
    return { error: "Vendor data not found", path: VENDOR_JSON };
  }

  let filtered = vendors;
  if (has_login) filtered = filtered.filter((v: any) => v.has_login);
  if (criticality) filtered = filtered.filter((v: any) => v.criticality === criticality);

  switch (action) {
    case "search": {
      if (!query) return { error: "query required" };
      const q = query.toLowerCase();
      const matches = filtered.filter((v: any) =>
        (v.name || "").toLowerCase().includes(q) ||
        (v.department || "").toLowerCase().includes(q) ||
        (v.description || "").toLowerCase().includes(q) ||
        (v.notes || "").toLowerCase().includes(q)
      );
      return {
        action: "search", query, count: matches.length,
        vendors: matches.slice(offset, offset + limit).map(vendorSummary),
      };
    }

    case "list": {
      return {
        action: "list", total: filtered.length, offset, limit,
        vendors: filtered.slice(offset, offset + limit).map(vendorSummary),
      };
    }

    case "stats": {
      const byDept: Record<string, number> = {};
      const byCrit: Record<string, number> = {};
      let withLogin = 0, withSso = 0, withMfa = 0;
      for (const v of vendors) {
        byDept[v.department || "Unknown"] = (byDept[v.department || "Unknown"] || 0) + 1;
        byCrit[v.criticality || "Unknown"] = (byCrit[v.criticality || "Unknown"] || 0) + 1;
        if (v.has_login) withLogin++;
        if (v.sso) withSso++;
        if (v.mfa) withMfa++;
      }
      return {
        action: "stats", total: vendors.length,
        with_login: withLogin, with_sso: withSso, with_mfa: withMfa,
        by_department: byDept, by_criticality: byCrit,
      };
    }
  }
}

function vendorSummary(v: any) {
  return {
    name: v.name,
    org: v.org,
    department: v.department,
    criticality: v.criticality,
    has_login: v.has_login,
    sso: v.sso,
    mfa: v.mfa,
    user_count: v.user_count,
    cost_annual: v.cost_annual,
    description: v.description,
    url: v.url,
  };
}
