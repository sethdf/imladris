// Windmill Script: Slack List Channels (Read-Only)
// Investigation tool — lists channels in the workspace.
//
// Requires: f/devops/slack_user_token

import { slackApi } from "./slack_helper.ts";

export async function main(
  types: string = "public_channel,private_channel",
  limit: number = 100,
  search: string = "",
) {
  try {
    const channels: any[] = [];
    let cursor = "";

    while (channels.length < limit) {
      const params: Record<string, string | number> = {
        types,
        exclude_archived: "true",
        limit: Math.min(200, limit - channels.length),
      };
      if (cursor) params.cursor = cursor;

      const data = await slackApi("conversations.list", params);
      channels.push(...(data.channels || []));
      cursor = data.response_metadata?.next_cursor || "";
      if (!cursor || !data.channels?.length) break;
    }

    let filtered = channels.slice(0, limit);
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(
        (c: any) =>
          c.name?.toLowerCase().includes(s) ||
          c.purpose?.value?.toLowerCase().includes(s) ||
          c.topic?.value?.toLowerCase().includes(s)
      );
    }

    return {
      count: filtered.length,
      channels: filtered.map((c: any) => ({
        id: c.id,
        name: c.name,
        type: c.is_im ? "dm" : c.is_mpim ? "group_dm" : c.is_private ? "private" : "public",
        members: c.num_members || 0,
        topic: c.topic?.value || "",
        purpose: c.purpose?.value || "",
        is_archived: c.is_archived || false,
      })),
    };
  } catch (e) {
    return { error: String(e) };
  }
}
