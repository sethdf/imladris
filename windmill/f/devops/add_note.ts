// Windmill Script: Add Note to SDP Ticket
// Decision 4: SDP via Windmill scripts

export async function main(
  ticket_id: string,
  note: string,
  is_public: boolean = false,
) {
  const baseUrl = Bun.env.WM_VAR_F_DEVOPS_SDP_BASE_URL;
  const apiKey = Bun.env.WM_VAR_F_DEVOPS_SDP_API_KEY;

  if (!baseUrl || !apiKey) {
    return {
      error: "SDP credentials not configured",
      setup: "Set f/devops/sdp_base_url and f/devops/sdp_api_key in Windmill variables",
    };
  }

  if (!ticket_id || !note) {
    return { error: "ticket_id and note are required" };
  }

  const inputData = JSON.stringify({
    request_note: {
      description: note,
      show_to_requester: is_public,
    },
  });

  const url = `${baseUrl}/requests/${ticket_id}/notes?input_data=${encodeURIComponent(inputData)}`;

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

  return {
    ticket_id,
    note_id: data.request_note?.id,
    message: `Note added to ticket #${ticket_id}`,
  };
}
