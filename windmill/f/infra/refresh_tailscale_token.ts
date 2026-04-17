// Windmill Script: Refresh Tailscale OAuth2 Access Token
// Runs on schedule (every 45 min) to keep tailscale_access_token fresh.
// Tailscale OAuth tokens expire after 60 minutes.
//
// Reads: f/devops/tailscale_oauth_client_id, tailscale_oauth_client_secret
// Writes: f/devops/tailscale_access_token (updated with fresh access token)

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
    return (val.startsWith('"') ? JSON.parse(val) : val).trim();
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
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function main() {
  const clientId = await getVariable("f/devops/tailscale_oauth_client_id");
  const clientSecret = await getVariable("f/devops/tailscale_oauth_client_secret");

  if (!clientId || !clientSecret) {
    return {
      error: "Missing OAuth2 credentials",
      setup: "Set f/devops/tailscale_oauth_client_id and tailscale_oauth_client_secret in Windmill variables",
    };
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });

  const response = await fetch("https://api.tailscale.com/api/v2/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    return {
      error: `Tailscale OAuth error: ${response.status} ${response.statusText}`,
      body: await response.text(),
    };
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (data.error || !data.access_token) {
    return { error: `Tailscale OAuth failed: ${data.error || "no access_token"}` };
  }

  const updated = await setVariable("f/devops/tailscale_access_token", data.access_token);

  return {
    message: "Tailscale access token refreshed successfully",
    expires_in_seconds: data.expires_in,
    expires_in_minutes: Math.round((data.expires_in || 3600) / 60),
    updated_variable: "f/devops/tailscale_access_token",
    refreshed_at: new Date().toISOString(),
    stored: updated,
  };
}
