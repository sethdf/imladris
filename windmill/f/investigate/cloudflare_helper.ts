// Windmill Script: Cloudflare API Helper
// Shared helper for all Cloudflare investigation tools.
// Authenticates via API token (Bearer) to Cloudflare v4 API.
//
// Usage from other scripts:
//   import { cloudflareFetch, CF_BASE } from "./cloudflare_helper.ts";
//
// Requires Windmill variables:
//   f/devops/cloudflare_readonly_api (maps to BWS cloudflare-readonly-api)

import * as wmill from "windmill-client";

export const CF_BASE = "https://api.cloudflare.com/client/v4";

/**
 * Make an authenticated request to the Cloudflare v4 API.
 * Uses Bearer token authentication.
 */
export async function cloudflareFetch(
  path: string,
  options: {
    method?: "GET" | "POST";
    params?: Record<string, string | number | boolean | undefined>;
    body?: any;
  } = {}
): Promise<any> {
  const apiToken = await wmill.getVariable("f/devops/cloudflare_readonly_api");

  if (!apiToken) {
    throw new Error(
      "Cloudflare API token not configured. Set f/devops/cloudflare_readonly_api"
    );
  }

  const { method = "GET", params, body } = options;

  let url = `${CF_BASE}${path}`;

  if (params) {
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) sp.set(key, String(value));
    }
    const qs = sp.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  const fetchOpts: RequestInit = { method, headers };

  if (body) {
    fetchOpts.body = JSON.stringify(body);
  }

  const resp = await fetch(url, fetchOpts);

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Cloudflare API error ${resp.status} on ${method} ${path}: ${errBody}`);
  }

  return resp.json();
}

// Windmill main — test connectivity by verifying token
export async function main() {
  try {
    const result = await cloudflareFetch("/user/tokens/verify");
    return {
      status: result.success ? "connected" : "error",
      token_status: result.result?.status,
      base_url: CF_BASE,
    };
  } catch (e) {
    return {
      status: "error",
      error: String(e),
      setup: "Ensure f/devops/cloudflare_readonly_api is set",
    };
  }
}
