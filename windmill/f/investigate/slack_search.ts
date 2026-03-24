// Windmill Script: Slack Search Messages (Read-Only)
// Investigation tool — searches messages across the workspace.
//
// Requires: f/devops/slack_user_token (must be a user token for search)

import { slackApi } from "./slack_helper.ts";

export async function main(
  query: string,
  sort: string = "timestamp",
  sort_dir: string = "desc",
  count: number = 20,
) {
  try {
    if (!query) return { error: "query parameter is required" };

    const data = await slackApi("search.messages", {
      query,
      sort,
      sort_dir,
      count: Math.min(100, count),
    });

    const matches = data.messages?.matches || [];

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
    for (const m of matches.slice(0, count)) {
      const author = m.user ? await userName(m.user) : m.username || "unknown";
      results.push({
        channel: m.channel?.name || m.channel?.id || "unknown",
        channel_id: m.channel?.id || "",
        author,
        text: m.text?.slice(0, 1000) || "",
        ts: m.ts,
        thread_ts: m.thread_ts || null,
        permalink: m.permalink || "",
        time: new Date(parseFloat(m.ts) * 1000).toISOString(),
      });
    }

    return {
      query,
      total: data.messages?.total || 0,
      count: results.length,
      results,
    };
  } catch (e) {
    return { error: String(e) };
  }
}
