import { bedrockInvoke, MODELS } from "./bedrock.ts";

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

interface FailedJob {
  id: string;
  script_path: string;
  started_at: string;
  duration_ms: number;
  error: string;
}

interface Classification {
  job_id: string;
  script_path: string;
  category: string;
  severity: string;
  suggested_fix: string;
  likely_to_recur: boolean;
}

export async function main() {
  const TAG = "[parse_windmill_logs]";
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";

  if (!token) {
    console.log(`${TAG} No WM_TOKEN — cannot query jobs API`);
    return { total_failed: 0, analyzed: 0, actionable: 0, transient: 0, slack_notified: false };
  }

  const headers = { Authorization: `Bearer ${token}` };
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);

  // Step 1: Fetch recent completed jobs (failed only)
  console.log(`${TAG} Fetching recent failed jobs...`);

  let allJobs: any[] = [];
  try {
    const url = `${base}/api/w/${workspace}/jobs/completed/list?per_page=50&order_desc=true&success=false`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      console.log(`${TAG} Jobs API returned ${resp.status}: ${await resp.text()}`);
      return { total_failed: 0, analyzed: 0, actionable: 0, transient: 0, slack_notified: false };
    }
    allJobs = await resp.json();
  } catch (err: any) {
    console.log(`${TAG} Failed to fetch jobs: ${err.message}`);
    return { total_failed: 0, analyzed: 0, actionable: 0, transient: 0, slack_notified: false };
  }

  // Filter to last 30 minutes
  const recentFailed = allJobs.filter((j: any) => {
    const started = new Date(j.started_at || j.created_at);
    return started >= cutoff;
  });

  console.log(`${TAG} Found ${recentFailed.length} failed jobs in last 30 minutes`);

  if (recentFailed.length === 0) {
    return { total_failed: 0, analyzed: 0, actionable: 0, transient: 0, slack_notified: false };
  }

  // Step 2: Extract error information
  const failedJobs: FailedJob[] = [];
  for (const job of recentFailed) {
    let error = "";

    // Try to get error from the job result or logs
    if (job.result && typeof job.result === "object" && job.result.error) {
      error = String(job.result.error);
    } else if (typeof job.result === "string") {
      error = job.result;
    }

    // If no error in list response, fetch job details
    if (!error) {
      try {
        const detailResp = await fetch(
          `${base}/api/w/${workspace}/jobs_u/completed/get/${job.id}`,
          { headers },
        );
        if (detailResp.ok) {
          const detail = await detailResp.json();
          if (detail.result && typeof detail.result === "object" && detail.result.error) {
            error = String(detail.result.error);
          } else if (typeof detail.result === "string") {
            error = detail.result;
          } else if (detail.logs) {
            // Grab last few lines of logs as error context
            const lines = String(detail.logs).split("\n").filter(Boolean);
            error = lines.slice(-5).join("\n");
          }
        }
      } catch {
        error = "Could not retrieve error details";
      }
    }

    failedJobs.push({
      id: job.id,
      script_path: job.script_path || job.raw_flow?.modules?.[0]?.value?.path || "unknown",
      started_at: job.started_at || job.created_at,
      duration_ms: job.duration_ms || 0,
      error: error.slice(0, 500),
    });
  }

  console.log(`${TAG} Extracted errors from ${failedJobs.length} jobs`);

  // Step 3: Send to Haiku for classification
  let classifications: Classification[] = [];
  try {
    const jobSummaries = failedJobs.map((j, i) => (
      `Job ${i + 1}:\n  id: ${j.id}\n  script: ${j.script_path}\n  error: ${j.error}`
    )).join("\n\n");

    const prompt = `Classify each failed Windmill job error below into one of these categories:
- transient (retry-safe, e.g. timeouts, rate limits, temporary network issues)
- configuration (missing env vars, bad paths, wrong credentials)
- dependency_failure (external service down, API changes)
- code_bug (null references, type errors, logic errors)
- resource_exhaustion (OOM, disk full, connection pool)
- timeout (job exceeded time limit)

For each job, respond with JSON only — no other text. Use this exact schema:
{
  "classifications": [
    {
      "job_id": "the job id",
      "script_path": "the script path",
      "category": "one of the categories above",
      "severity": "low|medium|high",
      "suggested_fix": "one sentence fix",
      "likely_to_recur": true/false
    }
  ]
}

Here are the failed jobs:

${jobSummaries}`;

    const result = await bedrockInvoke(prompt, {
      model: MODELS.HAIKU,
      maxTokens: 2048,
      parseJson: true,
    });

    classifications = result.classifications || [];
    console.log(`${TAG} Haiku classified ${classifications.length} errors`);
  } catch (err: any) {
    console.log(`${TAG} Haiku classification failed: ${err.message}`);
    // Fall back to marking everything as unknown
    classifications = failedJobs.map((j) => ({
      job_id: j.id,
      script_path: j.script_path,
      category: "unknown",
      severity: "medium" as const,
      suggested_fix: "Classification unavailable — review manually",
      likely_to_recur: true,
    }));
  }

  const transient = classifications.filter(
    (c) => c.category === "transient" || c.category === "timeout",
  );
  const actionable = classifications.filter(
    (c) => c.category !== "transient" && c.category !== "timeout",
  );

  console.log(`${TAG} ${transient.length} transient, ${actionable.length} actionable`);

  // Step 4: Post to Slack if there are actionable findings
  let slackNotified = false;

  if (actionable.length > 0) {
    try {
      const slackToken = await getVariable("f/devops/slack_user_token");
      const slackChannel = await getVariable("f/devops/slack_approval_channel");

      const effectiveChannel = slackChannel || "U06H2KKCCET"; // fallback to Seth DM — never a channel
      if (!slackToken) {
        console.log(`${TAG} Slack token or channel not configured — skipping notification`);
      } else {
        const blocks: any[] = [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `${recentFailed.length} failed jobs in last 30min`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${actionable.length} need attention, ${transient.length} transient (ignored)`,
            },
          },
        ];

        for (const item of actionable) {
          const severityIcon =
            item.severity === "high" ? ":red_circle:" :
            item.severity === "medium" ? ":large_orange_circle:" :
            ":white_circle:";

          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${severityIcon} *${item.script_path}*\n${item.category} — ${item.suggested_fix}${item.likely_to_recur ? " _(will recur)_" : ""}`,
            },
          });
        }

        const slackResp = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${slackToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel: effectiveChannel,
            text: `${actionable.length} actionable failures in last 30min`,
            blocks,
          }),
        });

        const slackData = await slackResp.json();
        if (slackData.ok) {
          slackNotified = true;
          console.log(`${TAG} Posted to Slack channel ${slackChannel}`);
        } else {
          console.log(`${TAG} Slack API error: ${slackData.error}`);
        }
      }
    } catch (err: any) {
      console.log(`${TAG} Slack notification failed: ${err.message}`);
    }
  } else {
    console.log(`${TAG} All errors transient — no Slack notification needed`);
  }

  return {
    total_failed: recentFailed.length,
    analyzed: classifications.length,
    actionable: actionable.length,
    transient: transient.length,
    slack_notified: slackNotified,
  };
}
