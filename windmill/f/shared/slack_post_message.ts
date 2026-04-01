// Windmill Script: Slack Post Message
// Write tool — posts a message to a Slack channel or thread.
//
// Requires: f/devops/slack_user_token

import * as wmill from "windmill-client";

export async function main(
  channel: string,
  text: string,
  thread_ts: string = "",
  unfurl_links: boolean = false,
) {
  const token = await wmill.getVariable("f/devops/slack_user_token");
  if (!token) {
    return { error: "Slack token not configured. Set f/devops/slack_user_token" };
  }

  if (!channel || !text) {
    return { error: "channel and text are required" };
  }

  const body: any = { channel, text, unfurl_links };
  if (thread_ts) body.thread_ts = thread_ts;

  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();

  if (!data.ok) {
    return { error: `Slack API error: ${data.error}`, channel, thread_ts };
  }

  return {
    ok: true,
    channel: data.channel,
    ts: data.ts,
    message: `Posted to ${channel}${thread_ts ? " (thread)" : ""}`,
  };
}
