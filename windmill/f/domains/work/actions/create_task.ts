// Windmill Script: Create SDP Task (standalone work item, not a Request)
// Tasks are self-appointed work items; Requests are user-reported issues.
// Mirrors create_ticket.ts pattern but targets /api/v3/tasks endpoint.

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

/** Derive SDP Tasks URL from the base URL (which targets /api/v3) */
function getSdpTaskUrl(baseUrl: string): string {
  // sdp_base_url is e.g. "https://sdpondemand.manageengine.com/app/.../api/v3"
  // Tasks endpoint is at the same level: /api/v3/tasks
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${normalized}/tasks`;
}

export async function main(
  title: string,
  description: string,
  priority: string = "Medium",
  owner: string = "",
  status: string = "Open",
) {
  const baseUrl = await getVariable("f/devops/sdp_base_url");
  const apiKey = await getVariable("f/devops/sdp_api_key");

  if (!baseUrl || !apiKey) {
    return {
      error: "SDP credentials not configured",
      setup: "Set f/devops/sdp_base_url and f/devops/sdp_api_key in Windmill variables",
    };
  }

  if (!title || !description) {
    return { error: "title and description are required" };
  }

  const task: Record<string, unknown> = {
    title,
    description,
    priority: { name: priority },
    status: { name: status },
  };

  if (owner) task.owner = { name: owner };

  const inputData = JSON.stringify({ task });
  const taskUrl = getSdpTaskUrl(baseUrl);

  const response = await fetch(taskUrl, {
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
  const t = data.task || {};

  return {
    task_id: String(t.id || ""),
    title: t.title,
    status: t.status?.name,
    priority: t.priority?.name,
    created: t.created_time?.display_value,
    message: `Task #${t.id} created successfully`,
  };
}
