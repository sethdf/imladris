// Windmill Script: Sophos Central API Helper
// Shared helper for all Sophos investigation tools.
// Handles OAuth 2.0 client_credentials flow + tenant discovery via whoami.
//
// Usage from other scripts:
//   import { getSophosAuth, sophosFetch } from "./sophos_helper.ts";
//
// Requires Windmill variables:
//   f/devops/sophos_client_id
//   f/devops/sophos_client_secret

import * as wmill from "windmill-client";

const TOKEN_URL = "https://id.sophos.com/api/v2/oauth2/token";
const WHOAMI_URL = "https://api.central.sophos.com/whoami/v1";

interface SophosAuth {
  token: string;
  apiHost: string;
  tenantId: string;
}

/**
 * Authenticate and discover tenant API host.
 * 1. OAuth2 client_credentials → bearer token
 * 2. whoami → tenant-specific API host + tenant ID
 */
export async function getSophosAuth(): Promise<SophosAuth> {
  const clientId = await wmill.getVariable("f/devops/sophos_client_id");
  const clientSecret = await wmill.getVariable("f/devops/sophos_client_secret");

  if (!clientId || !clientSecret) {
    throw new Error(
      "Sophos credentials not configured. Set f/devops/sophos_client_id and f/devops/sophos_client_secret"
    );
  }

  // Step 1: Get OAuth token
  const tokenResp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&scope=token`,
  });

  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    throw new Error(`Sophos OAuth failed (${tokenResp.status}): ${body}`);
  }

  const tokenData = await tokenResp.json();
  const token = tokenData.access_token;

  // Step 2: Discover tenant
  const whoamiResp = await fetch(WHOAMI_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!whoamiResp.ok) {
    const body = await whoamiResp.text();
    throw new Error(`Sophos whoami failed (${whoamiResp.status}): ${body}`);
  }

  const whoami = await whoamiResp.json();
  const apiHost = whoami.apiHosts?.dataRegion;
  const tenantId = whoami.id;

  if (!apiHost) {
    throw new Error(`Sophos whoami missing apiHosts.dataRegion: ${JSON.stringify(whoami)}`);
  }

  return { token, apiHost, tenantId };
}

/**
 * Make an authenticated request to the Sophos Central tenant API.
 * Automatically discovers tenant API host and adds auth headers.
 */
export async function sophosFetch(
  path: string,
  options: {
    method?: "GET" | "POST";
    params?: Record<string, string | number | boolean | undefined>;
    body?: any;
  } = {}
): Promise<any> {
  const auth = await getSophosAuth();
  const { method = "GET", params, body } = options;

  let url = `${auth.apiHost}${path}`;

  if (params) {
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) sp.set(key, String(value));
    }
    const qs = sp.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    "X-Tenant-ID": auth.tenantId,
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
    throw new Error(`Sophos API error ${resp.status} on ${method} ${path}: ${errBody}`);
  }

  const text = await resp.text();
  if (!text) return {};
  return JSON.parse(text);
}

// Windmill main — test connectivity and return tenant info
export async function main() {
  try {
    const auth = await getSophosAuth();
    return {
      status: "connected",
      tenant_id: auth.tenantId,
      api_host: auth.apiHost,
      token_preview: `${auth.token.substring(0, 20)}...`,
    };
  } catch (e) {
    return {
      status: "error",
      error: String(e),
      setup: "Ensure f/devops/sophos_client_id and f/devops/sophos_client_secret are set",
    };
  }
}
