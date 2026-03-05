// Windmill Script: Aikido Security API Helper
// Shared helper for all Aikido investigation and devops tools.
// Handles OAuth 2.0 client_credentials flow for bearer token acquisition.
// All queries use the US region endpoint.
//
// Usage from other scripts:
//   import { getAikidoToken, aikidoFetch, AIKIDO_BASE } from "./aikido_helper.ts";
//
// Requires Windmill variables:
//   f/investigate/aikido_client_id
//   f/investigate/aikido_client_secret
//   f/investigate/aikido_base_url

import * as wmill from "windmill-client";

export const AIKIDO_TOKEN_URL = "https://app.aikido.dev/api/oauth/token";
export const AIKIDO_BASE = "https://app.aikido.dev/api/public/v1";

/**
 * Get a fresh OAuth bearer token using client credentials grant.
 * Tokens are short-lived (1 hour) — call once per script invocation.
 */
export async function getAikidoToken(): Promise<string> {
  const clientId = await wmill.getVariable("f/investigate/aikido_client_id");
  const clientSecret = await wmill.getVariable("f/investigate/aikido_client_secret");

  if (!clientId || !clientSecret) {
    throw new Error(
      "Aikido credentials not configured. Set f/investigate/aikido_client_id and f/investigate/aikido_client_secret"
    );
  }

  const basicAuth = btoa(`${clientId}:${clientSecret}`);

  const resp = await fetch(AIKIDO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Aikido OAuth failed (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  return data.access_token;
}

/**
 * Make an authenticated GET/POST request to the Aikido public API.
 * Automatically prepends the base URL and adds bearer token.
 */
export async function aikidoFetch(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: any;
    params?: Record<string, string | number | boolean | undefined>;
  } = {}
): Promise<any> {
  const token = await getAikidoToken();
  const { method = "GET", body, params } = options;

  let url = `${AIKIDO_BASE}${path}`;

  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        searchParams.set(key, String(value));
      }
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
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
    throw new Error(`Aikido API error ${resp.status} on ${method} ${path}: ${errBody}`);
  }

  const text = await resp.text();
  if (!text) return {};
  return JSON.parse(text);
}

// Windmill main — test connectivity and return workspace info
export async function main() {
  try {
    const token = await getAikidoToken();
    return {
      status: "connected",
      token_preview: `${token.substring(0, 20)}...`,
      base_url: AIKIDO_BASE,
      message: "Aikido OAuth token acquired successfully",
    };
  } catch (e) {
    return {
      status: "error",
      error: String(e),
      setup: "Ensure f/investigate/aikido_client_id and f/investigate/aikido_client_secret are set",
    };
  }
}
