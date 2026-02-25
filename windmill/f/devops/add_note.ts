// Windmill Script: Add Note to SDP Ticket
// Decision 4: SDP via Windmill scripts

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
  ticket_id: string,
  note: string,
  is_public: boolean = false,
) {
  const baseUrl = await getVariable("f/devops/sdp_base_url");
  const apiKey = await getVariable("f/devops/sdp_api_key");

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

  const response = await fetch(`${baseUrl}/requests/${ticket_id}/notes`, {
    method: "POST",
    headers: {
      ...SDP_HEADERS,
      Authorization: `Zoho-oauthtoken ${apiKey}`,
    },
    body: `input_data=${encodeURIComponent(inputData)}`,
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
