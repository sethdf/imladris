// Windmill Script: Get Monitoring Alerts (Read-Only)
// Investigation tool — queries Site24x7 for monitor status and active alarms.
// Uses Zoho OAuth — access token refreshed by f/devops/refresh_site24x7_token schedule.
//
// Requires Windmill variable: f/investigate/site24x7_access_token

import * as wmill from "windmill-client";

const STATUS_MAP: Record<number, string> = {
  0: "DOWN", 1: "UP", 2: "TROUBLE", 5: "CRITICAL", 7: "SUSPENDED", 9: "MAINTENANCE", 10: "DISCOVERY",
};

export async function main(
  action: "current_status" | "alarms" | "monitors" = "current_status",
  monitor_type: "SERVER" | "URL" | "ALL" = "SERVER",
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
      const url = monitor_type === "ALL"
        ? "https://www.site24x7.com/api/current_status"
        : `https://www.site24x7.com/api/current_status/type/${monitor_type}`;
      const resp = await fetch(url, { headers });
      if (!resp.ok) return { error: `Site24x7 API error: ${resp.status}`, body: await resp.text() };
      const data = await resp.json() as any;

      let monitors = data.data?.monitors || [];
      if (monitor_name) {
        const search = monitor_name.toLowerCase();
        monitors = monitors.filter((m: any) =>
          m.name?.toLowerCase().includes(search) ||
          m.serverinfo?.toLowerCase().includes(search)
        );
      }
      if (status_filter) {
        const statusCode = Object.entries(STATUS_MAP).find(([, v]) => v === status_filter)?.[0];
        if (statusCode !== undefined) {
          monitors = monitors.filter((m: any) => String(m.status) === statusCode);
        }
      }

      return {
        count: monitors.length,
        monitors: monitors.slice(0, limit).map((m: any) => ({
          name: m.name || m.serverinfo,
          monitor_id: m.monitor_id,
          status: STATUS_MAP[m.status] || `unknown(${m.status})`,
          last_polled: m.last_polled_time,
          down_reason: m.down_reason,
          duration: m.duration,
          server_type: m.server_type,
          server_version: m.server_version,
        })),
      };
    }

    case "alarms": {
      const resp = await fetch("https://www.site24x7.com/api/alarms", { headers });
      if (!resp.ok) return { error: `Site24x7 API error: ${resp.status}`, body: await resp.text() };
      const data = await resp.json() as any;

      let alarms = data.data || [];
      if (monitor_name) {
        const search = monitor_name.toLowerCase();
        alarms = alarms.filter((a: any) =>
          a.display_name?.toLowerCase().includes(search) ||
          a.subject?.toLowerCase().includes(search)
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
      const data = await resp.json() as any;

      let monitors = data.data || [];
      if (monitor_name) {
        const search = monitor_name.toLowerCase();
        monitors = monitors.filter((m: any) =>
          m.display_name?.toLowerCase().includes(search)
        );
      }

      return {
        count: monitors.length,
        monitors: monitors.slice(0, limit).map((m: any) => ({
          name: m.display_name,
          monitor_id: m.monitor_id,
          type: m.type,
          state: m.state,
          poll_interval: m.poll_interval,
        })),
      };
    }
  }
}
