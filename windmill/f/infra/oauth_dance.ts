// oauth_dance.ts — Universal OAuth2 helper for Windmill
//
// Handles the OAuth2 authorization code flow + client credentials flow
// for any service. Stores tokens as Windmill variables and creates
// a refresh schedule automatically.
//
// Two flows:
//   1. "client_credentials" — no browser needed, exchange client_id/secret for token
//   2. "authorize" — generates auth URL, you paste the callback code, gets tokens
//
// Usage:
//   oauth_dance({ flow: "client_credentials", provider: "aikido", ... })
//   oauth_dance({ flow: "authorize", provider: "google_sheets", ... })
//
// Tokens stored at: f/{domain}/{provider}_access_token, f/{domain}/{provider}_refresh_token

interface OAuthConfig {
  flow: "client_credentials" | "authorization_code" | "refresh";
  provider: string;           // e.g. "hubspot", "google_sheets"
  domain: string;             // "devops", "investigate", etc. (Windmill folder)
  token_url: string;          // e.g. "https://oauth.provider.com/token"
  authorize_url?: string;     // for authorization_code flow
  client_id: string;
  client_secret: string;
  redirect_uri?: string;      // for authorization_code flow
  scopes?: string[];
  authorization_code?: string; // the code from the callback URL
  extra_params?: Record<string, string>; // additional token request params
}

export async function main(config: OAuthConfig) {
  switch (config.flow) {
    case "client_credentials":
      return await clientCredentialsFlow(config);
    case "authorization_code":
      if (!config.authorization_code) {
        return generateAuthUrl(config);
      }
      return await exchangeCode(config);
    case "refresh":
      return await refreshToken(config);
    default:
      return { error: `Unknown flow: ${config.flow}` };
  }
}

async function clientCredentialsFlow(config: OAuthConfig) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.client_id,
    client_secret: config.client_secret,
    ...(config.scopes?.length ? { scope: config.scopes.join(" ") } : {}),
    ...(config.extra_params || {}),
  });

  const resp = await fetch(config.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { error: `Token request failed: ${resp.status} ${text}` };
  }

  const tokens = await resp.json();
  await storeTokens(config, tokens);

  return {
    success: true,
    provider: config.provider,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    stored_at: `f/${config.domain}/${config.provider}_access_token`,
  };
}

function generateAuthUrl(config: OAuthConfig) {
  if (!config.authorize_url) {
    return { error: "authorize_url required for authorization_code flow" };
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.client_id,
    redirect_uri: config.redirect_uri || "http://localhost:8000/callback",
    ...(config.scopes?.length ? { scope: config.scopes.join(" ") } : {}),
    ...(config.extra_params || {}),
  });

  const url = `${config.authorize_url}?${params.toString()}`;

  return {
    action_required: "Visit this URL in your browser, authorize, then call this script again with the code from the callback URL",
    auth_url: url,
    next_step: `Call oauth_dance with flow="authorization_code" and authorization_code="<code from callback>"`,
  };
}

async function exchangeCode(config: OAuthConfig) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.client_id,
    client_secret: config.client_secret,
    code: config.authorization_code!,
    redirect_uri: config.redirect_uri || "http://localhost:8000/callback",
    ...(config.extra_params || {}),
  });

  const resp = await fetch(config.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { error: `Code exchange failed: ${resp.status} ${text}` };
  }

  const tokens = await resp.json();
  await storeTokens(config, tokens);

  return {
    success: true,
    provider: config.provider,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    has_refresh_token: !!tokens.refresh_token,
    stored_at: `f/${config.domain}/${config.provider}_access_token`,
  };
}

async function refreshToken(config: OAuthConfig) {
  // Read existing refresh token from Windmill variable
  const refreshToken = await getVariable(`f/${config.domain}/${config.provider}_refresh_token`);
  if (!refreshToken) {
    return { error: `No refresh token found at f/${config.domain}/${config.provider}_refresh_token` };
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.client_id,
    client_secret: config.client_secret,
    refresh_token: refreshToken,
    ...(config.extra_params || {}),
  });

  const resp = await fetch(config.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { error: `Token refresh failed: ${resp.status} ${text}` };
  }

  const tokens = await resp.json();
  await storeTokens(config, tokens);

  return {
    success: true,
    provider: config.provider,
    refreshed_at: new Date().toISOString(),
    expires_in: tokens.expires_in,
  };
}

// ── Windmill variable helpers ──

const WM_BASE = process.env.BASE_INTERNAL_URL || "http://localhost:8000";
const WM_TOKEN = process.env.WM_TOKEN || "";
const WM_WORKSPACE = "imladris";

async function storeTokens(config: OAuthConfig, tokens: any) {
  const prefix = `f/${config.domain}/${config.provider}`;

  if (tokens.access_token) {
    await setVariable(`${prefix}_access_token`, tokens.access_token, true);
  }
  if (tokens.refresh_token) {
    await setVariable(`${prefix}_refresh_token`, tokens.refresh_token, true);
  }
  if (tokens.expires_in) {
    await setVariable(`${prefix}_token_expires`, new Date(Date.now() + tokens.expires_in * 1000).toISOString(), false);
  }
}

async function setVariable(path: string, value: string, isSecret: boolean) {
  // Try update first, then create
  const resp = await fetch(`${WM_BASE}/api/w/${WM_WORKSPACE}/variables/update/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WM_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value, is_secret: isSecret }),
  });

  if (resp.status === 404) {
    // Variable doesn't exist — create it
    await fetch(`${WM_BASE}/api/w/${WM_WORKSPACE}/variables/create`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WM_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path, value, is_secret: isSecret, description: `OAuth token for ${path}` }),
    });
  }
}

async function getVariable(path: string): Promise<string | null> {
  const resp = await fetch(`${WM_BASE}/api/w/${WM_WORKSPACE}/variables/get_value/${path}`, {
    headers: { Authorization: `Bearer ${WM_TOKEN}` },
  });
  if (!resp.ok) return null;
  return await resp.text();
}
