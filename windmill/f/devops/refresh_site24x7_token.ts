// Windmill Script: Refresh Site24x7 OAuth2 Access Token
// Runs on schedule (every 45 min) to keep site24x7_access_token fresh.
// Zoho access tokens expire after 60 minutes.
//
// Reads: f/devops/site24x7_client_id, site24x7_client_secret, site24x7_refresh_token
// Writes: f/investigate/site24x7_access_token (updated with fresh access token)

async function getVariable(path: string): Promise<string | undefined> {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";
  if (!token) return undefined;
  try {
    const resp = await fetch(
      `${base}/api/w/${workspace}/variables/get_value/${path}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) return undefined;
    const val = await resp.text();
    const parsed = val.startsWith('"') ? JSON.parse(val) : val;
    return parsed.trim();
  } catch {
    return undefined;
  }
}

async function setVariable(path: string, value: string): Promise<boolean> {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";
  if (!token) return false;
  try {
    const resp = await fetch(
      `${base}/api/w/${workspace}/variables/update/${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function main() {
  const clientId = await getVariable("f/devops/site24x7_client_id");
  const clientSecret = await getVariable("f/devops/site24x7_client_secret");
  const refreshToken = await getVariable("f/devops/site24x7_refresh_token");

  if (!clientId || !clientSecret || !refreshToken) {
    return {
      error: "Missing OAuth2 credentials",
      setup:
        "Set f/devops/site24x7_client_id, site24x7_client_secret, and site24x7_refresh_token in Windmill variables",
    };
  }

  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    return {
      error: `Zoho OAuth error: ${response.status} ${response.statusText}`,
      body: await response.text(),
    };
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (data.error || !data.access_token) {
    return {
      error: `Zoho OAuth failed: ${data.error || "no access_token in response"}`,
    };
  }

  const updated = await setVariable(
    "f/investigate/site24x7_access_token",
    data.access_token,
  );

  if (!updated) {
    return {
      error: "Failed to update site24x7_access_token variable in Windmill",
      token_received: true,
    };
  }

  return {
    message: "Site24x7 access token refreshed successfully",
    expires_in_seconds: data.expires_in,
    expires_in_minutes: Math.round((data.expires_in || 3600) / 60),
    updated_variable: "f/investigate/site24x7_access_token",
    refreshed_at: new Date().toISOString(),
  };
}
