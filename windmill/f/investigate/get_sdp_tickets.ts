// Windmill Script: Get SDP Tickets (Read-Only)
// Investigation tool — read-only SDP ticket lookup.
// Wraps the SDP REST API with search and filter capabilities.
// For write operations (create/close/add note), use f/devops/ scripts.

import * as wmill from "windmill-client";

const SDP_ACCEPT = "application/vnd.manageengine.sdp.v3+json";

export async function main(
  ticket_id?: string,
  search?: string,
  status?: "Open" | "In Progress" | "On Hold" | "Resolved" | "Closed",
  requester?: string,
  technician?: string,
  limit: number = 20,
) {
  const baseUrl = await wmill.getVariable("f/devops/sdp_base_url");
  const apiKey = await wmill.getVariable("f/devops/sdp_api_key");

  if (!baseUrl || !apiKey) {
    return { error: "SDP credentials not configured", setup: "Set f/devops/sdp_base_url and f/devops/sdp_api_key" };
  }

  const headers = {
    Authorization: `Zoho-oauthtoken ${apiKey}`,
    Accept: SDP_ACCEPT,
  };

  // Direct ticket lookup by ID
  if (ticket_id) {
    const resp = await fetch(`${baseUrl}/requests/${ticket_id}`, { headers });
    if (!resp.ok) return { error: `SDP API error: ${resp.status}`, body: await resp.text() };
    const data = await resp.json();
    const req = data.request;
    return {
      ticket: {
        id: req?.display_id || req?.id,
        subject: req?.subject,
        status: req?.status?.name,
        priority: req?.priority?.name,
        technician: req?.technician?.name,
        requester: req?.requester?.name,
        description: req?.description,
        created: req?.created_time?.display_value,
        due: req?.due_by_time?.display_value,
        resolution: req?.resolution?.content,
      },
    };
  }

  // Search with filters
  const criteria: any[] = [];
  if (search) criteria.push({ field: "subject", condition: "contains", value: search });
  if (status) criteria.push({ field: "status.name", condition: "is", value: status });
  if (requester) criteria.push({ field: "requester.name", condition: "contains", value: requester });
  if (technician) criteria.push({ field: "technician.name", condition: "is", value: technician });

  const listInfo: any = {
    list_info: {
      row_count: limit,
      sort_field: "created_time",
      sort_order: "desc",
    },
  };
  if (criteria.length > 0) listInfo.list_info.search_criteria = criteria;

  const url = `${baseUrl}/requests?input_data=${encodeURIComponent(JSON.stringify(listInfo))}`;
  const resp = await fetch(url, { headers });

  if (!resp.ok) return { error: `SDP API error: ${resp.status}`, body: await resp.text() };
  const data = await resp.json();
  const requests = data.requests || [];

  return {
    count: requests.length,
    tickets: requests.map((r: any) => ({
      id: r.display_id,
      subject: r.subject,
      status: r.status?.name,
      priority: r.priority?.name,
      technician: r.technician?.name,
      requester: r.requester?.name,
      created: r.created_time?.display_value,
      due: r.due_by_time?.display_value,
    })),
  };
}
