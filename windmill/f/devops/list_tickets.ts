// Windmill Script: List SDP Tickets
// Decision 4: SDP via Windmill scripts
//
// Requires Windmill variables:
//   f/devops/sdp_base_url   — e.g., https://sdpondemand.manageengine.com/app/itdesk/api/v3
//   f/devops/sdp_api_key    — Zoho OAuth access token (refreshed by refresh_sdp_token cron)

// SDP API requires this Accept header — Bun's default Accept: */* causes 415
const SDP_HEADERS = {
  Accept: "application/vnd.manageengine.sdp.v3+json",
  "Content-Type": "application/x-www-form-urlencoded",
};

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

export async function main(
  status: string = "",
  limit: number = 20,
  technician: string = "",
) {
  const baseUrl = await getVariable("f/devops/sdp_base_url");
  const apiKey = await getVariable("f/devops/sdp_api_key");

  if (!baseUrl || !apiKey) {
    return {
      error: "SDP credentials not configured",
      setup: "Set f/devops/sdp_base_url and f/devops/sdp_api_key in Windmill variables",
    };
  }

  const listInfo: Record<string, unknown> = {
    list_info: {
      row_count: limit,
      sort_field: "created_time",
      sort_order: "desc",
    },
  };

  const criteria: Record<string, unknown>[] = [];
  if (status) criteria.push({ field: "status.name", condition: "is", value: status });
  if (technician) criteria.push({ field: "technician.name", condition: "is", value: technician });
  if (criteria.length > 0) listInfo.list_info = { ...listInfo.list_info as object, search_criteria: criteria };

  const url = `${baseUrl}/requests?input_data=${encodeURIComponent(JSON.stringify(listInfo))}`;

  const response = await fetch(url, {
    headers: {
      ...SDP_HEADERS,
      Authorization: `Zoho-oauthtoken ${apiKey}`,
    },
  });

  if (!response.ok) {
    return {
      error: `SDP API error: ${response.status} ${response.statusText}`,
      body: await response.text(),
    };
  }

  const data = await response.json();
  const requests = data.requests || [];

  return {
    count: requests.length,
    status_filter: status || "all",
    tickets: requests.map((r: Record<string, unknown>) => ({
      id: (r as any).id,
      subject: (r as any).subject,
      status: (r as any).status?.name,
      priority: (r as any).priority?.name,
      technician: (r as any).technician?.name,
      created: (r as any).created_time?.display_value,
    })),
  };
}
