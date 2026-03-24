// Windmill Script: Read Telegram Messages from a Chat
// Returns messages from a specified chat by ID, username, or title search.

import { getTelegramClient } from "./telegram_helper.ts";

export async function main(
  chat: string,
  limit: number = 20,
  search: string = ""
) {
  const client = await getTelegramClient();

  try {
    // Resolve chat - try as number (ID) first, then as username/title
    let target: string | number = chat;
    const parsed = parseInt(chat);
    if (!isNaN(parsed)) {
      target = parsed;
    }

    const opts: Record<string, any> = { limit };
    if (search) opts.search = search;

    const messages = [];
    for await (const msg of client.iterMessages(target, opts)) {
      let senderName = "unknown";
      if (msg.sender) {
        const s = msg.sender as any;
        if (s.firstName || s.lastName) {
          senderName = [s.firstName, s.lastName].filter(Boolean).join(" ");
        } else if (s.title) {
          senderName = s.title;
        } else if (s.username) {
          senderName = `@${s.username}`;
        }
      }

      messages.push({
        id: msg.id,
        date: msg.date ? new Date(msg.date * 1000).toISOString() : null,
        sender_id: msg.senderId?.toString(),
        sender_name: senderName,
        text: msg.text || null,
        has_media: !!msg.media,
        reply_to: msg.replyTo?.replyToMsgId || null,
      });
    }

    return {
      chat,
      count: messages.length,
      messages,
    };
  } finally {
    await client.disconnect();
  }
}
