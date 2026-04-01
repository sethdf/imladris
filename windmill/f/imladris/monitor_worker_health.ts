const BASE = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
const TOKEN = process.env.WM_TOKEN;
const WS = process.env.WM_WORKSPACE || "imladris";
const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

async function getVariable(path: string): Promise<string | undefined> {
  if (!TOKEN) return undefined;
  try {
    const resp = await fetch(
      `${BASE}/api/w/${WS}/variables/get_value/${path}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    if (!resp.ok) return undefined;
    const val = await resp.text();
    const parsed = val.startsWith('"') ? JSON.parse(val) : val;
    return parsed.trim();
  } catch {
    return undefined;
  }
}

async function wmApi(path: string, options?: RequestInit): Promise<any> {
  if (!TOKEN) return null;
  try {
    const resp = await fetch(`${BASE}/api/${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function main() {
  const summary = {
    workers_online: 0,
    workers_total: 0,
    stuck_jobs_found: 0,
    stuck_jobs_cancelled: 0,
    alerts_sent: 0,
  };

  console.log("[monitor_worker_health] starting health check");

  // 1. Check worker status
  const workers: any[] = (await wmApi("workers/list")) || [];
  const now = Date.now();
  const onlineWorkers = workers.filter((w: any) => {
    // last_ping is seconds since last ping (relative), not a timestamp
    const secsSincePing = typeof w.last_ping === "number" ? w.last_ping : Infinity;
    return secsSincePing < 60;
  });
  summary.workers_total = workers.length;
  summary.workers_online = onlineWorkers.length;
  const offlineWorkers = workers.filter(
    (w: any) => !onlineWorkers.includes(w),
  );
  console.log(
    `[monitor_worker_health] workers: ${summary.workers_online}/${summary.workers_total} online`,
  );

  // 2. Detect stuck jobs
  const runningJobs: any[] =
    (await wmApi(`w/${WS}/jobs/list?running=true`)) || [];
  const stuckJobs = runningJobs.filter((j: any) => {
    if (!j.started_at) return false;
    const started = new Date(j.started_at).getTime();
    return now - started > STUCK_THRESHOLD_MS;
  });
  summary.stuck_jobs_found = stuckJobs.length;
  console.log(
    `[monitor_worker_health] running jobs: ${runningJobs.length}, stuck (>5min): ${stuckJobs.length}`,
  );

  // 3. Cancel stuck jobs
  const cancelledIds: string[] = [];
  for (const job of stuckJobs) {
    const result = await wmApi(`w/${WS}/jobs_u/queue/cancel/${job.id}`, {
      method: "POST",
      body: JSON.stringify({
        reason:
          "Cancelled by worker health monitor — job exceeded 5 minute timeout",
      }),
    });
    if (result !== null) {
      cancelledIds.push(job.id);
      const runMin = ((now - new Date(job.started_at).getTime()) / 60000).toFixed(1);
      console.log(
        `[monitor_worker_health] cancelled job ${job.id} (${job.script_path || "unknown"}, running ${runMin}min)`,
      );
    } else {
      console.log(
        `[monitor_worker_health] failed to cancel job ${job.id}`,
      );
    }
  }
  summary.stuck_jobs_cancelled = cancelledIds.length;

  // 4. Alert via Slack if there are issues
  const hasOfflineWorkers = offlineWorkers.length > 0;
  const hasStuckJobs = stuckJobs.length > 0;

  if (hasOfflineWorkers || hasStuckJobs) {
    try {
      const slackToken = await getVariable("f/devops/slack_user_token");
      const channel = (await getVariable("f/devops/slack_approval_channel")) || "U06H2KKCCET"; // fallback to Seth DM — never a channel
      if (slackToken) {
        const lines: string[] = [];
        if (hasStuckJobs) {
          const jobList = stuckJobs
            .map((j: any) => {
              const runMin = (
                (now - new Date(j.started_at).getTime()) /
                60000
              ).toFixed(0);
              return `\`${j.script_path || j.id}\` (${runMin}min)`;
            })
            .join(", ");
          lines.push(
            `found ${stuckJobs.length} stuck job${stuckJobs.length > 1 ? "s" : ""} (running >5min), cancelled ${cancelledIds.length}: ${jobList}`,
          );
        }
        if (hasOfflineWorkers) {
          const names = offlineWorkers
            .map((w: any) => w.worker || w.name || "unknown")
            .join(", ");
          lines.push(`${offlineWorkers.length} worker${offlineWorkers.length > 1 ? "s" : ""} appear offline: ${names}`);
        }
        lines.push(
          `workers online: ${summary.workers_online}/${summary.workers_total}`,
        );

        const blocks = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:warning: *windmill worker health*\n${lines.join("\n")}`,
            },
          },
        ];

        const resp = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${slackToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ channel, blocks }),
        });
        const data = await resp.json();
        if (data.ok) {
          summary.alerts_sent = 1;
          console.log("[monitor_worker_health] slack alert sent");
        } else {
          console.log(
            `[monitor_worker_health] slack error: ${data.error}`,
          );
        }
      } else {
        console.log(
          "[monitor_worker_health] slack token or channel not configured, skipping alert",
        );
      }
    } catch (e: any) {
      console.log(
        `[monitor_worker_health] slack alert failed: ${e.message}`,
      );
    }
  } else {
    console.log("[monitor_worker_health] all clear, no alert needed");
  }

  console.log("[monitor_worker_health] done", JSON.stringify(summary));
  return summary;
}
