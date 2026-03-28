// Windmill Script: SigNoz API Helper
// Shared helper for all SigNoz investigation tools.
// Authenticates via API key header to SigNoz Cloud.
//
// Usage from other scripts:
//   import { signozFetch, SIGNOZ_BASE } from "./signoz_helper.ts";
//
// Requires Windmill variables:
//   f/devops/signoz_api_key (maps to BWS api-signoz-poc-admin)

import * as wmill from "windmill-client";

export const SIGNOZ_BASE = "https://rare-weevil.us.signoz.cloud";

/**
 * Make an authenticated request to the SigNoz API.
 * Uses SIGNOZ-API-KEY header for authentication.
 */
export async function signozFetch(
  path: string,
  options: {
    method?: "GET" | "POST";
    params?: Record<string, string | number | boolean | undefined>;
    body?: any;
  } = {}
): Promise<any> {
  const apiKey = await wmill.getVariable("f/devops/signoz_api_key");

  if (!apiKey) {
    throw new Error(
      "SigNoz API key not configured. Set f/devops/signoz_api_key"
    );
  }

  const { method = "GET", params, body } = options;

  let url = `${SIGNOZ_BASE}${path}`;

  if (params) {
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) sp.set(key, String(value));
    }
    const qs = sp.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    "SIGNOZ-API-KEY": apiKey,
    Accept: "application/json",
  };

  const fetchOpts: RequestInit = { method, headers };

  if (body) {
    headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(body);
  }

  const resp = await fetch(url, fetchOpts);

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`SigNoz API error ${resp.status} on ${method} ${path}: ${errBody}`);
  }

  const text = await resp.text();
  if (!text) return {};
  return JSON.parse(text);
}

// Windmill main — test connectivity
export async function main() {
  try {
    // Try fetching alert rules as a connectivity test
    const result = await signozFetch("/api/v1/rules");
    const ruleCount = result?.data?.rules?.length ?? result?.data?.length ?? "unknown";
    return {
      status: "connected",
      base_url: SIGNOZ_BASE,
      alert_rules: ruleCount,
    };
  } catch (e) {
    return {
      status: "error",
      error: String(e),
      setup: "Ensure f/devops/signoz_api_key is set",
    };
  }
}
