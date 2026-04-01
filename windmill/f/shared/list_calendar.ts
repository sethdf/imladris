// Windmill Script: List M365 Calendar Events (Microsoft Graph)
// Intake source for upcoming meetings — work items from calendar.
//
// Requires Windmill variables:
//   f/devops/m365_tenant_id   — Azure AD tenant ID
//   f/devops/m365_client_id   — App registration client ID
//   f/devops/m365_client_secret — App registration client secret
//
// Azure AD app needs Calendars.Read application permission (admin-consented).

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

async function getM365Token(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<{ token?: string; error?: string }> {
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!resp.ok) {
    return { error: `Token request failed: ${resp.status} ${await resp.text()}` };
  }

  const data = (await resp.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    return { error: `No access_token in response: ${data.error || "unknown"}` };
  }
  return { token: data.access_token };
}

export async function main(
  user_email: string = "sfoley@buxtonco.com",
  days_ahead: number = 7,
  limit: number = 50,
) {
  const tenantId = await getVariable("f/devops/m365_tenant_id");
  const clientId = await getVariable("f/devops/m365_client_id");
  const clientSecret = await getVariable("f/devops/m365_client_secret");

  if (!tenantId || !clientId || !clientSecret) {
    return {
      error: "M365 credentials not configured",
      setup: "Set f/devops/m365_tenant_id, m365_client_id, and m365_client_secret in Windmill variables",
    };
  }

  const auth = await getM365Token(tenantId, clientId, clientSecret);
  if (auth.error) {
    return { error: auth.error };
  }

  const now = new Date();
  const end = new Date(now.getTime() + days_ahead * 86400000);

  const graphUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user_email)}/calendarView?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$top=${limit}&$orderby=start/dateTime&$select=id,subject,start,end,location,organizer,isAllDay,isCancelled,showAs,importance,bodyPreview,attendees`;

  const response = await fetch(graphUrl, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Prefer: 'outlook.timezone="America/Chicago"',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    return {
      error: `Graph API error: ${response.status} ${response.statusText}`,
      body,
      hint: response.status === 403
        ? "App may need Calendars.Read application permission with admin consent"
        : undefined,
    };
  }

  const data = (await response.json()) as { value?: any[] };
  const events = (data.value || []).filter((e: any) => !e.isCancelled);

  // Cache for cross-source correlation
  try {
    const { store, isAvailable, init } = await import("./cache_lib.ts");
    if (isAvailable()) {
      init();
      for (const e of events) {
        const attendeeNames = (e.attendees || [])
          .map((a: any) => a.emailAddress?.name || a.emailAddress?.address || "")
          .join(" ");
        store(
          "m365", "calendar", String(e.id),
          e.subject || "(no subject)",
          `${e.subject || ""} ${e.organizer?.emailAddress?.name || ""} ${attendeeNames} ${e.bodyPreview || ""}`,
          e,
        );
      }
    }
  } catch { /* cache unavailable — continue without it */ }

  return {
    count: events.length,
    user: user_email,
    days_ahead,
    period: { from: now.toISOString(), to: end.toISOString() },
    events: events.map((e: any) => ({
      id: e.id,
      subject: e.subject,
      start: e.start?.dateTime,
      end: e.end?.dateTime,
      all_day: e.isAllDay,
      location: e.location?.displayName,
      organizer: e.organizer?.emailAddress?.name,
      organizer_email: e.organizer?.emailAddress?.address,
      show_as: e.showAs,
      importance: e.importance,
      attendees: (e.attendees || []).map((a: any) => ({
        name: a.emailAddress?.name,
        email: a.emailAddress?.address,
        status: a.status?.response,
      })),
      preview: e.bodyPreview?.slice(0, 200),
    })),
  };
}
