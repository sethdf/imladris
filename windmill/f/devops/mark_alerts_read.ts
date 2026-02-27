// Windmill Script: Mark Alert Emails as Read in M365
// Identifies automated alert senders and bulk-marks their unread emails as read.
// Uses Graph API JSON batching ($batch) for efficiency — up to 20 per batch request.
//
// Requires Windmill variables:
//   f/devops/m365_tenant_id, m365_client_id, m365_client_secret
//
// Azure AD app needs Mail.ReadWrite application permission (admin-consented).

// Known automated alert senders — emails from these are marked read automatically
const ALERT_SENDERS = [
  "Office365Alerts@microsoft.com",
  "noreply@site24x7.com",
  "noreply@buxtonco.com",
  "do-not-reply@central.sophos.com",
  "databasealerts@buxtonco.com",
  "buxprod01@buxtonco.com",
  "health@aws.com",
  "MSSecurity-noreply@microsoft.com",
  "budgets@costalerts.amazonaws.com",
  "no-reply@skeddly.com",
  "CloudPlatform-noreply@google.com",
  "noreply@pdq.com",
  "alerts@trustalerts.okta.com",
];

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
  dry_run: boolean = false,
  max_emails: number = 5000,
  extra_senders: string = "",
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

  // Merge default + extra senders
  const senders = [...ALERT_SENDERS];
  if (extra_senders) {
    for (const s of extra_senders.split(",")) {
      const trimmed = s.trim().toLowerCase();
      if (trimmed && !senders.map(x => x.toLowerCase()).includes(trimmed)) {
        senders.push(trimmed);
      }
    }
  }

  // Build OData filter: unread + from any alert sender
  const senderFilters = senders.map(s => `from/emailAddress/address eq '${s}'`);
  const filterStr = `isRead eq false and (${senderFilters.join(" or ")})`;

  // Paginate to collect all matching message IDs
  const allIds: string[] = [];
  let nextUrl: string | null = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user_email)}/messages?$top=1000&$select=id,from&$filter=${encodeURIComponent(filterStr)}`;

  while (nextUrl && allIds.length < max_emails) {
    const resp = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      return {
        error: `Graph API error: ${resp.status} ${resp.statusText}`,
        body,
        hint: resp.status === 403
          ? "App may need Mail.ReadWrite application permission with admin consent"
          : undefined,
        marked_so_far: allIds.length,
      };
    }

    const data = (await resp.json()) as { value?: any[]; "@odata.nextLink"?: string };
    const batch = data.value || [];
    for (const m of batch) {
      allIds.push(m.id);
    }
    nextUrl = data["@odata.nextLink"] || null;
  }

  if (allIds.length === 0) {
    return {
      message: "No unread alert emails found",
      senders_checked: senders.length,
    };
  }

  if (dry_run) {
    return {
      dry_run: true,
      would_mark_read: allIds.length,
      senders_checked: senders.length,
      senders,
    };
  }

  // Mark as read using Graph API JSON batching (20 requests per batch)
  let marked = 0;
  let errors = 0;
  const BATCH_SIZE = 20;

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const chunk = allIds.slice(i, i + BATCH_SIZE);
    const batchRequests = chunk.map((msgId, idx) => ({
      id: String(idx + 1),
      method: "PATCH",
      url: `/users/${encodeURIComponent(user_email)}/messages/${msgId}`,
      headers: { "Content-Type": "application/json" },
      body: { isRead: true },
    }));

    const batchResp = await fetch("https://graph.microsoft.com/v1.0/$batch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests: batchRequests }),
    });

    if (batchResp.ok) {
      const batchData = (await batchResp.json()) as { responses?: any[] };
      for (const r of batchData.responses || []) {
        if (r.status >= 200 && r.status < 300) {
          marked++;
        } else {
          errors++;
        }
      }
    } else {
      errors += chunk.length;
    }
  }

  // Update local cache in parallel — mark these items as read
  let cacheUpdated = 0;
  try {
    const { isAvailable, init } = await import("./cache_lib.ts");
    if (isAvailable()) {
      init();
      // Import bun:sqlite directly to update the cache DB
      const { Database } = await import("bun:sqlite");
      const cacheDir = process.env.CACHE_DIR || "/local/cache/triage";
      const dbPath = `${cacheDir}/index.db`;
      const { existsSync } = await import("fs");
      if (existsSync(dbPath)) {
        const db = new Database(dbPath);
        // Add is_read column if not present
        try {
          db.exec("ALTER TABLE items ADD COLUMN is_read INTEGER DEFAULT 0");
        } catch { /* column already exists */ }

        const update = db.prepare(
          "UPDATE items SET is_read = 1 WHERE id = ?"
        );
        for (const msgId of allIds) {
          const itemId = `m365:email:${msgId}`;
          const result = update.run(itemId);
          if ((result as any).changes > 0) cacheUpdated++;
        }
        db.close();
      }
    }
  } catch { /* cache update failed — source is still correct */ }

  return {
    total_found: allIds.length,
    marked_read: marked,
    errors,
    cache_updated: cacheUpdated,
    senders_checked: senders.length,
    senders,
  };
}
