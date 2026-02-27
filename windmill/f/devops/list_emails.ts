// Windmill Script: List M365 Emails (Microsoft Graph)
// Intake source for unread email — work items from inbox.
//
// Requires Windmill variables:
//   f/devops/m365_tenant_id   — Azure AD tenant ID
//   f/devops/m365_client_id   — App registration client ID
//   f/devops/m365_client_secret — App registration client secret
//
// Azure AD app needs Mail.Read application permission (admin-consented).

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
  unread_only: boolean = true,
  limit: number = 0,
  days_back: number = 0,
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

  // Build OData filter
  const filters: string[] = [];
  if (unread_only) filters.push("isRead eq false");
  if (days_back > 0) {
    const since = new Date(Date.now() - days_back * 86400000).toISOString();
    filters.push(`receivedDateTime ge ${since}`);
  }
  const filterStr = filters.length > 0 ? `&$filter=${encodeURIComponent(filters.join(" and "))}` : "";

  // Graph API pages at max 1000 per request. Paginate to get all unread.
  const pageSize = Math.min(limit > 0 ? limit : 1000, 1000);
  const allMessages: any[] = [];
  let nextUrl: string | null = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user_email)}/messages?$top=${pageSize}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,isRead,importance,hasAttachments,bodyPreview${filterStr}`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        error: `Graph API error: ${response.status} ${response.statusText}`,
        body,
        hint: response.status === 403
          ? "App may need Mail.Read application permission with admin consent"
          : undefined,
      };
    }

    const data = (await response.json()) as { value?: any[]; "@odata.nextLink"?: string };
    const batch = data.value || [];
    allMessages.push(...batch);

    // Stop if we hit the limit or no more pages
    if (limit > 0 && allMessages.length >= limit) {
      allMessages.length = limit;
      break;
    }
    nextUrl = data["@odata.nextLink"] || null;
  }

  // Cache for cross-source correlation
  try {
    const { store, isAvailable, init } = await import("./cache_lib.ts");
    if (isAvailable()) {
      init();
      for (const m of allMessages) {
        store(
          "m365", "email", String(m.id),
          m.subject || "(no subject)",
          `${m.subject || ""} ${m.from?.emailAddress?.name || ""} ${m.from?.emailAddress?.address || ""} ${m.bodyPreview || ""}`,
          m,
        );
      }
    }
  } catch { /* cache unavailable — continue without it */ }

  // Sanitize strings for Postgres JSON storage (strip null bytes + control chars)
  const clean = (s: string | undefined): string =>
    (s || "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

  // Return summary to Windmill (result stored in Postgres — keep it small).
  // Full data lives in the cache for triage/correlation.
  const mapped = allMessages.map((m: any) => ({
    id: m.id,
    subject: clean(m.subject),
    from_name: clean(m.from?.emailAddress?.name),
    from_email: clean(m.from?.emailAddress?.address),
    received: m.receivedDateTime,
    is_read: m.isRead,
    importance: m.importance,
    has_attachments: m.hasAttachments,
    preview: clean(m.bodyPreview?.slice(0, 200)),
  }));

  // Sender breakdown for summary
  const senders: Record<string, number> = {};
  for (const m of mapped) {
    const addr = m.from_email || "unknown";
    senders[addr] = (senders[addr] || 0) + 1;
  }
  const topSenders = Object.entries(senders)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([email, count]) => ({ email, count }));

  // Cap the returned emails list at 100 — full set is in cache
  const returnLimit = 100;
  return {
    count: mapped.length,
    returned: Math.min(mapped.length, returnLimit),
    cached: mapped.length,
    user: user_email,
    unread_only,
    days_back: days_back || "all",
    top_senders: topSenders,
    emails: mapped.slice(0, returnLimit),
    note: mapped.length > returnLimit
      ? `Showing ${returnLimit} of ${mapped.length}. Full set cached for triage.`
      : undefined,
  };
}
