// Windmill Script: Sophos Get Events
// Investigation tool — queries SIEM events from Sophos Central.

import { sophosFetch } from "./sophos_helper.ts";

export async function main(
  hours: number = 24,
  event_type?: string,
  limit: number = 100,
) {
  const fromDate = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const params: Record<string, string | number | boolean | undefined> = {
    limit,
    from_date: fromDate,
  };

  const data = await sophosFetch("/siem/v1/events", { params });

  let events = (data.items || data || []).map((e: any) => ({
    id: e.id,
    type: e.type,
    severity: e.severity,
    name: e.name,
    location: e.location,
    source: e.source,
    group: e.group,
    customer_id: e.customer_id,
    endpoint_type: e.endpoint_type,
    endpoint_id: e.endpoint_id,
    created_at: e.created_at,
    when: e.when,
  }));

  if (event_type) {
    events = events.filter((e: any) =>
      e.type?.toLowerCase().includes(event_type.toLowerCase()) ||
      e.name?.toLowerCase().includes(event_type.toLowerCase())
    );
  }

  return {
    from: fromDate,
    returned: events.length,
    has_more: data.has_more ?? false,
    next_cursor: data.next_cursor,
    events,
  };
}
