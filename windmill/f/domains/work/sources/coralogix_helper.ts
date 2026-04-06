// Windmill Script: Coralogix API Helper
// Shared helper for all Coralogix investigation tools.
// Authenticates via Bearer token to Coralogix Cloud.
//
// Usage from other scripts:
//   import { coralogixFetch, getCoralogixBase } from "./coralogix_helper.ts";
//
// Requires Windmill variables:
//   f/devops/coralogix_api_key     — Query/Logs API key (Authorization: Bearer)
//   f/devops/coralogix_region      — Region slug: us1, us2, eu1, eu2, ap1, ap2, ap3

import * as wmill from "windmill-client";

// Region → endpoint map (Coralogix docs: coralogix.com/docs/integrations/coralogix-endpoints/)
const REGION_ENDPOINTS: Record<string, { api: string; ingress: string }> = {
  us1: { api: "api.us1.coralogix.com",  ingress: "ingress.us1.coralogix.com" },
  us2: { api: "api.us2.coralogix.com",  ingress: "ingress.us2.coralogix.com" },
  eu1: { api: "api.eu1.coralogix.com",  ingress: "ingress.eu1.coralogix.com" },
  eu2: { api: "api.eu2.coralogix.com",  ingress: "ingress.eu2.coralogix.com" },
  ap1: { api: "api.ap1.coralogix.com",  ingress: "ingress.ap1.coralogix.com" },
  ap2: { api: "api.ap2.coralogix.com",  ingress: "ingress.ap2.coralogix.com" },
  ap3: { api: "api.ap3.coralogix.com",  ingress: "ingress.ap3.coralogix.com" },
};

/**
 * Returns the base API URL for the configured region.
 */
export async function getCoralogixBase(): Promise<string> {
  const region = (await wmill.getVariable("f/devops/coralogix_region")) ?? "us1";
  const endpoints = REGION_ENDPOINTS[region];
  if (!endpoints) {
    throw new Error(`Unknown Coralogix region: "${region}". Valid: ${Object.keys(REGION_ENDPOINTS).join(", ")}`);
  }
  return `https://${endpoints.api}`;
}

/**
 * Returns the OTLP ingress hostname for the configured region.
 */
export async function getCoralogixIngress(): Promise<string> {
  const region = (await wmill.getVariable("f/devops/coralogix_region")) ?? "us1";
  const endpoints = REGION_ENDPOINTS[region];
  if (!endpoints) {
    throw new Error(`Unknown Coralogix region: "${region}"`);
  }
  return endpoints.ingress;
}

/**
 * Make an authenticated request to the Coralogix API.
 * Uses Authorization: Bearer <API_KEY> for authentication.
 */
export async function coralogixFetch(
  path: string,
  options: {
    method?: "GET" | "POST";
    params?: Record<string, string | number | boolean | undefined>;
    body?: any;
    apiKeyVar?: string; // defaults to f/devops/coralogix_api_key
  } = {}
): Promise<any> {
  const { method = "GET", params, body, apiKeyVar = "f/devops/coralogix_api_key" } = options;

  const [apiKey, base] = await Promise.all([
    wmill.getVariable(apiKeyVar),
    getCoralogixBase(),
  ]);

  if (!apiKey) {
    throw new Error(
      `Coralogix API key not configured. Set ${apiKeyVar} in Windmill variables.`
    );
  }

  let url = `${base}${path}`;

  if (params) {
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) sp.set(key, String(value));
    }
    const qs = sp.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
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
    throw new Error(`Coralogix API error ${resp.status} on ${method} ${path}: ${errBody}`);
  }

  const text = await resp.text();
  if (!text) return {};
  return JSON.parse(text);
}

// Windmill main — test connectivity
export async function main() {
  try {
    const base = await getCoralogixBase();
    // List alerts as a connectivity test
    const result = await coralogixFetch("/api/v2/external/alerts");
    const alertCount = result?.alerts?.length ?? result?.total ?? "unknown";
    return {
      status: "connected",
      base_url: base,
      alerts: alertCount,
    };
  } catch (e) {
    return {
      status: "error",
      error: String(e),
      setup: "Ensure f/devops/coralogix_api_key and f/devops/coralogix_region are set",
    };
  }
}
