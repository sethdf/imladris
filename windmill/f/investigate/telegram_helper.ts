// Windmill Script: Telegram MTProto Helper
// Shared helper for all Telegram investigation tools.
// Handles session reconnection via StringSession.
//
// Usage from other scripts:
//   import { getTelegramClient } from "./telegram_helper.ts";
//
// Requires Windmill variables:
//   f/investigate/telegram_api_id
//   f/investigate/telegram_api_hash
//   f/investigate/telegram_session

import * as wmill from "windmill-client";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

/**
 * Get an authenticated Telegram client using stored session string.
 * Call client.disconnect() when done.
 */
export async function getTelegramClient(): Promise<TelegramClient> {
  const apiId = parseInt(await wmill.getVariable("f/investigate/telegram_api_id"));
  const apiHash = await wmill.getVariable("f/investigate/telegram_api_hash");
  const sessionStr = await wmill.getVariable("f/investigate/telegram_session");

  if (!apiId || !apiHash || !sessionStr) {
    throw new Error(
      "Telegram credentials not configured. Set f/investigate/telegram_api_id, telegram_api_hash, and telegram_session"
    );
  }

  const session = new StringSession(sessionStr);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  return client;
}
