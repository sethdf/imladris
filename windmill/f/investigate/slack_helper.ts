// Windmill Script: Slack API Helper
// Shared helper for all Slack investigation and devops tools.
// Handles authentication and provides a typed API wrapper with rate limiting.
//
// Usage from other scripts:
//   import { getSlackToken, slackApi } from "./slack_helper.ts";
//
// Requires Windmill variable: f/devops/slack_user_token

import * as wmill from "windmill-client";

const SLACK_API_BASE = "https://slack.com/api";

export async function getSlackToken(): Promise<string> {
  const token = await wmill.getVariable("f/devops/slack_user_token");
  if (!token) {
    throw new Error(
      "Slack token not configured. Set f/devops/slack_user_token in Windmill variables"
    );
  }
  return token;
}

export async function slackApi(
  method: string,
  params: Record<string, string | number | boolean | undefined> = {},
  options: { token?: string; maxRetries?: number; body?: any } = {}
): Promise<any> {
  const token = options.token || (await getSlackToken());
  const maxRetries = options.maxRetries || 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let resp: Response;

    if (options.body) {
      // POST with JSON body
      resp = await fetch(`${SLACK_API_BASE}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(options.body),
      });
    } else {
      // GET with query params
      const url = new URL(`${SLACK_API_BASE}/${method}`);
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      }
      resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("Retry-After") || "5");
      console.log(`[slack] Rate limited, waiting ${retryAfter}s...`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (!resp.ok) {
      throw new Error(
        `Slack API ${method} HTTP ${resp.status}: ${await resp.text().catch(() => "")}`
      );
    }

    const data = await resp.json();
    if (!data.ok) {
      throw new Error(`Slack API ${method} error: ${data.error}`);
    }
    return data;
  }

  throw new Error(`Slack API ${method}: max retries exceeded (rate limited)`);
}

// Windmill main — test connectivity
export async function main() {
  try {
    const data = await slackApi("auth.test");
    return {
      status: "connected",
      user: data.user,
      team: data.team,
      team_id: data.team_id,
      url: data.url,
    };
  } catch (e) {
    return { status: "error", error: String(e) };
  }
}
