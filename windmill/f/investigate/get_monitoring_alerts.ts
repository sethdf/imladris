// Windmill Script: Get Monitoring Alerts (Read-Only)
// Investigation tool — queries Site24x7 for monitor status and active alarms.
// Uses Zoho OAuth pattern (same as SDP).
//
// Requires Windmill variable: f/investigate/site24x7_access_token

import * as wmill from "windmill-client";

export async function main(
  action: "current_status" | "alarms" | "monitors" = "current_status",
  monitor_name?: string,
  status_filter?: "DOWN" | "TROUBLE" | "UP" | "CRITICAL",
  limit: number = 50,
) {
  const accessToken = await wmill.getVariable("f/investigate/site24x7_access_token");

  if (!accessToken) {
    return { error: "Site24x7 credentials not configured", setup: "Set f/investigate/site24x7_access_token Windmill variable" };
  }

  const headers = {
    Authorization: `Zoho-oauthtoken ${accessToken}`,
    Accept: "application/json; version=2.0",
  };

  switch (action) {
    case "current_status": {
      const resp = await fetch("https://www.site24x7.com/api/current_status", { headers });
      if (!resp.ok) return { error: `Site24x7 API error: ${resp.status}`, body: await resp.text() };
      const data = await resp.json();

      let monitors = data.data?.monitors || [];
      if (monitor_name) {
        monitors = monitors.filter((m: any) =>
          m.name?.toLowerCase().includes(monitor_name.toLowerCase())
        );
      }
      if (status_filter) {
        const statusMap: Record<string, number> = { DOWN: 0, TROUBLE: 2, UP: 1, CRITICAL: 5 };
        monitors = monitors.filter((m: any) => m.status === statusMap[status_filter]);
      }

      return {
        count: monitors.length,
        monitors: monitors.slice(0, limit).map((m: any) => ({
          name: m.name,
          status: m.status === 0 ? "DOWN" : m.status === 1 ? "UP" : m.status === 2 ? "TROUBLE" : m.status === 5 ? "CRITICAL" : `unknown(${m.status})`,
          type: m.type,
          last_polled: m.last_polled_time,
          down_reason: m.down_reason,
          duration: m.duration,
        })),
      };
    }

    case "alarms": {
      const resp = await fetch("https://www.site24x7.com/api/alarms", { headers });
      if (!resp.ok) return { error: `Site24x7 API error: ${resp.status}`, body: await resp.text() };
      const data = await resp.json();

      let alarms = data.data || [];
      if (monitor_name) {
        alarms = alarms.filter((a: any) =>
          a.display_name?.toLowerCase().includes(monitor_name.toLowerCase())
        );
      }

      return {
        count: alarms.length,
        alarms: alarms.slice(0, limit).map((a: any) => ({
          monitor_name: a.display_name,
          severity: a.severity,
          subject: a.subject,
          started: a.start_time,
          duration: a.duration,
        })),
      };
    }

    case "monitors": {
      const resp = await fetch("https://www.site24x7.com/api/monitors", { headers });
      if (!resp.ok) return { error: `Site24x7 API error: ${resp.status}`, body: await resp.text() };
      const data = await resp.json();

      let monitors = data.data || [];
      if (monitor_name) {
        monitors = monitors.filter((m: any) =>
          m.display_name?.toLowerCase().includes(monitor_name.toLowerCase())
        );
      }

      return {
        count: monitors.length,
        monitors: monitors.slice(0, limit).map((m: any) => ({
          name: m.display_name,
          type: m.type,
          state: m.state,
          poll_interval: m.poll_interval,
          timeout: m.timeout,
        })),
      };
    }
  }
}
