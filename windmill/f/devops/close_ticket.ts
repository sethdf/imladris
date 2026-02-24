// Windmill Script: Close/Resolve SDP Ticket
// Decision 4: SDP via Windmill scripts

export async function main(
  ticket_id: string,
  resolution: string = "",
  status: string = "Resolved",
) {
  const baseUrl = Bun.env.WM_VAR_F_DEVOPS_SDP_BASE_URL;
  const apiKey = Bun.env.WM_VAR_F_DEVOPS_SDP_API_KEY;

  if (!baseUrl || !apiKey) {
    return {
      error: "SDP credentials not configured",
      setup: "Set f/devops/sdp_base_url and f/devops/sdp_api_key in Windmill variables",
    };
  }

  if (!ticket_id) {
    return { error: "ticket_id is required" };
  }

  const request: Record<string, unknown> = {
    status: { name: status },
  };

  if (resolution) {
    request.resolution = { content: resolution };
  }

  const inputData = JSON.stringify({ request });
  const url = `${baseUrl}/requests/${ticket_id}?input_data=${encodeURIComponent(inputData)}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Zoho-oauthtoken ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!response.ok) {
    return {
      error: `SDP API error: ${response.status} ${response.statusText}`,
      body: await response.text(),
    };
  }

  const data = await response.json();
  const req = data.request || {};

  return {
    id: req.id,
    subject: req.subject,
    status: req.status?.name,
    message: `Ticket #${ticket_id} ${status.toLowerCase()}`,
  };
}
