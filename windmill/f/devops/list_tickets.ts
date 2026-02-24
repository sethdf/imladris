// Windmill Script: List SDP Tickets
// Decision 4: SDP via Windmill scripts
//
// Requires Windmill variables:
//   f/devops/sdp_base_url   — e.g., https://sdpondemand.manageengine.com/api/v3
//   f/devops/sdp_api_key    — OAuth token from Bitwarden sync

export async function main(
  status: string = "open",
  limit: number = 20,
  technician: string = "",
) {
  const baseUrl = Bun.env.WM_VAR_F_DEVOPS_SDP_BASE_URL;
  const apiKey = Bun.env.WM_VAR_F_DEVOPS_SDP_API_KEY;

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
      search_criteria: [
        { field: "status.name", condition: "is", value: status },
        ...(technician
          ? [{ field: "technician.name", condition: "is", value: technician }]
          : []),
      ],
    },
  };

  const url = `${baseUrl}/requests?input_data=${encodeURIComponent(JSON.stringify(listInfo))}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${apiKey}`,
      Accept: "application/json",
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
    status_filter: status,
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
