// Windmill Script: Slack List Channels (Read-Only)
// Investigation tool — lists channels in the workspace.
// Migrated from direct Slack API to Steampipe (read-only by enforcement).

import { steampipeQuery } from "./steampipe_helper.ts";

export async function main(
  types: string = "public_channel,private_channel",
  limit: number = 100,
  search: string = "",
) {
  const typeSet = new Set(types.split(",").map(t => t.trim()));

  const conditions: string[] = ["is_archived = false"];
  const params: any[] = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(name ILIKE $${params.length} OR purpose ILIKE $${params.length} OR topic ILIKE $${params.length})`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const rows = await steampipeQuery(`
    SELECT
      id,
      name,
      is_private,
      is_im,
      is_mpim,
      is_archived,
      num_members       AS members,
      topic,
      purpose
    FROM slack.slack_conversation
    ${where}
    ORDER BY name ASC
    LIMIT ${limit}
  `, params.length ? params : undefined);

  // Apply type filter client-side (Steampipe slack plugin returns all conversation types)
  const includePublic  = typeSet.has("public_channel");
  const includePrivate = typeSet.has("private_channel");
  const includeDm      = typeSet.has("im");
  const includeGroupDm = typeSet.has("mpim");

  const filtered = rows.filter((c: any) => {
    if (c.is_im)    return includeDm;
    if (c.is_mpim)  return includeGroupDm;
    if (c.is_private) return includePrivate;
    return includePublic;
  });

  return {
    count: filtered.length,
    channels: filtered.map((c: any) => ({
      id:          c.id,
      name:        c.name,
      type:        c.is_im ? "dm" : c.is_mpim ? "group_dm" : c.is_private ? "private" : "public",
      members:     c.members || 0,
      topic:       c.topic || "",
      purpose:     c.purpose || "",
      is_archived: c.is_archived || false,
    })),
  };
}
