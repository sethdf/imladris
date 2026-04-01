// Windmill Script: Slack User Info (Read-Only)
// Investigation tool — looks up user profile by ID or searches by name/email.
//
// Requires: f/devops/slack_user_token

import { slackApi } from "./slack_helper.ts";

export async function main(
  user_id: string = "",
  email: string = "",
  name_search: string = "",
) {
  try {
    // Direct lookup by user ID
    if (user_id) {
      const data = await slackApi("users.info", { user: user_id });
      const u = data.user;
      return {
        id: u.id,
        name: u.name,
        real_name: u.real_name || u.profile?.real_name || "",
        display_name: u.profile?.display_name || "",
        email: u.profile?.email || "",
        title: u.profile?.title || "",
        status_text: u.profile?.status_text || "",
        timezone: u.tz || "",
        is_admin: u.is_admin || false,
        is_bot: u.is_bot || false,
        deleted: u.deleted || false,
      };
    }

    // Lookup by email
    if (email) {
      const data = await slackApi("users.lookupByEmail", { email });
      const u = data.user;
      return {
        id: u.id,
        name: u.name,
        real_name: u.real_name || u.profile?.real_name || "",
        display_name: u.profile?.display_name || "",
        email: u.profile?.email || "",
        title: u.profile?.title || "",
        status_text: u.profile?.status_text || "",
        timezone: u.tz || "",
        is_admin: u.is_admin || false,
        is_bot: u.is_bot || false,
        deleted: u.deleted || false,
      };
    }

    // Search by name — fetch all users and filter
    if (name_search) {
      const search = name_search.toLowerCase();
      const users: any[] = [];
      let cursor = "";

      while (users.length < 500) {
        const params: Record<string, string | number> = { limit: 200 };
        if (cursor) params.cursor = cursor;
        const data = await slackApi("users.list", params);
        users.push(...(data.members || []));
        cursor = data.response_metadata?.next_cursor || "";
        if (!cursor) break;
      }

      const matches = users.filter((u: any) => {
        const rn = (u.real_name || "").toLowerCase();
        const dn = (u.profile?.display_name || "").toLowerCase();
        const n = (u.name || "").toLowerCase();
        return rn.includes(search) || dn.includes(search) || n.includes(search);
      });

      return {
        query: name_search,
        count: matches.length,
        users: matches.slice(0, 20).map((u: any) => ({
          id: u.id,
          name: u.name,
          real_name: u.real_name || "",
          display_name: u.profile?.display_name || "",
          email: u.profile?.email || "",
          title: u.profile?.title || "",
          is_bot: u.is_bot || false,
          deleted: u.deleted || false,
        })),
      };
    }

    return { error: "Provide user_id, email, or name_search" };
  } catch (e) {
    return { error: String(e) };
  }
}
