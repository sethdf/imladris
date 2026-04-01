// Windmill Script: List Telegram Chats/Dialogs
// Returns a list of recent chats with their IDs and types.

import { getTelegramClient } from "./telegram_helper.ts";

export async function main(limit: number = 50) {
  const client = await getTelegramClient();

  try {
    const dialogs = await client.getDialogs({ limit });
    const results = [];

    for (const dialog of dialogs) {
      const entity = dialog.entity;
      let type = "unknown";
      if (entity) {
        if (entity.className === "Channel") type = "channel";
        else if (entity.className === "Chat") type = "group";
        else if (entity.className === "User") type = "dm";
      }

      results.push({
        id: dialog.id?.toString(),
        title: dialog.title || "(no title)",
        type,
        unread_count: dialog.unreadCount,
        last_message: dialog.message?.text?.substring(0, 100) || null,
        last_date: dialog.date ? new Date(dialog.date * 1000).toISOString() : null,
      });
    }

    return { total: dialogs.total, count: results.length, chats: results };
  } finally {
    await client.disconnect();
  }
}
