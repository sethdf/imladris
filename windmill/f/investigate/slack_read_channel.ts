// Windmill Script: Slack Read Channel (Read-Only)
// Investigation tool — reads recent messages from a channel.
//
// Requires: f/devops/slack_user_token

import { slackApi } from "./slack_helper.ts";

export async function main(
  channel: string,
  limit: number = 25,
  oldest: string = "",
  latest: string = "",
) {
  try {
    const params: Record<string, string | number> = {
      channel,
      limit: Math.min(100, limit),
    };
    if (oldest) params.oldest = oldest;
    if (latest) params.latest = latest;

    const data = await slackApi("conversations.history", params);
    const messages = data.messages || [];

    // Resolve user names
    const userCache = new Map<string, string>();
    async function userName(userId: string): Promise<string> {
      if (!userId) return "unknown";
      if (userCache.has(userId)) return userCache.get(userId)!;
      try {
        const info = await slackApi("users.info", { user: userId });
        const name = info.user?.real_name || info.user?.name || userId;
        userCache.set(userId, name);
        return name;
      } catch {
        userCache.set(userId, userId);
        return userId;
      }
    }

    const results = [];
    for (const msg of messages.slice(0, limit)) {
      const author = msg.user ? await userName(msg.user) : msg.bot_id ? `bot:${msg.bot_id}` : "unknown";
      results.push({
        ts: msg.ts,
        author,
        text: msg.text?.slice(0, 2000) || "",
        thread_ts: msg.thread_ts || null,
        reply_count: msg.reply_count || 0,
        has_files: !!(msg.files?.length),
        time: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      });
    }

    return {
      channel,
      count: results.length,
      has_more: data.has_more || false,
      messages: results,
    };
  } catch (e) {
    return { error: String(e) };
  }
}
