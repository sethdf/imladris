// Windmill Script: Create SDP Ticket
// Decision 4: SDP via Windmill scripts

export async function main(
  subject: string,
  description: string,
  priority: string = "Medium",
  category: string = "",
  requester_email: string = "",
) {
  const baseUrl = Bun.env.WM_VAR_F_DEVOPS_SDP_BASE_URL;
  const apiKey = Bun.env.WM_VAR_F_DEVOPS_SDP_API_KEY;

  if (!baseUrl || !apiKey) {
    return {
      error: "SDP credentials not configured",
      setup: "Set f/devops/sdp_base_url and f/devops/sdp_api_key in Windmill variables",
    };
  }

  if (!subject || !description) {
    return { error: "subject and description are required" };
  }

  const request: Record<string, unknown> = {
    subject,
    description,
    priority: { name: priority },
  };

  if (category) request.category = { name: category };
  if (requester_email) request.requester = { email_id: requester_email };

  const inputData = JSON.stringify({ request });
  const url = `${baseUrl}/requests?input_data=${encodeURIComponent(inputData)}`;

  const response = await fetch(url, {
    method: "POST",
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
    priority: req.priority?.name,
    created: req.created_time?.display_value,
    message: `Ticket #${req.id} created successfully`,
  };
}
