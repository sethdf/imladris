// Windmill Script: Slack Read Thread (Read-Only)
// Investigation tool — reads all replies in a thread.
//
// Requires: f/devops/slack_user_token

import { slackApi } from "./slack_helper.ts";

export async function main(
  channel: string,
  thread_ts: string,
  limit: number = 100,
) {
  try {
    const replies: any[] = [];
    let cursor = "";

    while (replies.length < limit) {
      const params: Record<string, string | number> = {
        channel,
        ts: thread_ts,
        limit: Math.min(100, limit - replies.length),
      };
      if (cursor) params.cursor = cursor;

      const data = await slackApi("conversations.replies", params);
      replies.push(...(data.messages || []));
      cursor = data.response_metadata?.next_cursor || "";
      if (!cursor || !data.has_more) break;
    }

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
    for (const msg of replies.slice(0, limit)) {
      const author = msg.user ? await userName(msg.user) : msg.bot_id ? `bot:${msg.bot_id}` : "unknown";
      results.push({
        ts: msg.ts,
        author,
        text: msg.text?.slice(0, 2000) || "",
        is_parent: msg.ts === thread_ts,
        time: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      });
    }

    return {
      channel,
      thread_ts,
      count: results.length,
      messages: results,
    };
  } catch (e) {
    return { error: String(e) };
  }
}
