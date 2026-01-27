/**
 * Telegram Adapter
 *
 * Syncs messages from Telegram Bot API into the intake system.
 * Thread-first model: each chat is a conversation.
 */

import {
  upsertIntake,
  addMessage,
  buildThreadContext,
  getSyncState,
  updateSyncState,
  generateId,
  hashContent,
  type IntakeItem,
  type Message,
  type Zone,
} from "../db/database.js";
import { BaseAdapter, type AdapterConfig, type SyncResult, registerAdapter } from "./base.js";

// =============================================================================
// Types
// =============================================================================

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
    title?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  from?: {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  text?: string;
  reply_to_message?: TelegramMessage;
}

interface TelegramConfig extends AdapterConfig {
  credentials: {
    botToken: string;
    allowedChatId?: string; // Optional: only sync from this chat
  };
}

// =============================================================================
// Telegram Adapter
// =============================================================================

export class TelegramAdapter extends BaseAdapter {
  private config: TelegramConfig;
  private baseUrl: string;

  constructor(config: TelegramConfig) {
    super(config);
    this.config = config;
    this.baseUrl = `https://api.telegram.org/bot${config.credentials.botToken}`;
  }

  /**
   * Validate bot token and connectivity
   */
  async validate(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/getMe`);
      const data = await response.json() as { ok: boolean };
      return data.ok === true;
    } catch {
      return false;
    }
  }

  /**
   * Sync messages from Telegram
   */
  async sync(cursor?: string): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      itemsProcessed: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      errors: [],
    };

    try {
      // Get stored offset
      const syncState = getSyncState(this.source);
      let offset = cursor ? parseInt(cursor, 10) : syncState?.cursor ? parseInt(syncState.cursor, 10) : 0;

      // Fetch updates
      const url = `${this.baseUrl}/getUpdates?offset=${offset}&timeout=30`;
      const response = await fetch(url);
      const data = await response.json() as { ok: boolean; result?: TelegramUpdate[] };

      if (!data.ok || !data.result) {
        result.errors.push("Failed to fetch updates from Telegram");
        return result;
      }

      const updates = data.result;
      console.log(`Processing ${updates.length} Telegram updates...`);

      for (const update of updates) {
        result.itemsProcessed++;

        // Update offset for next sync
        offset = update.update_id + 1;

        if (!update.message?.text) continue;

        const msg = update.message;

        // Filter by allowed chat if configured
        if (this.config.credentials.allowedChatId) {
          if (String(msg.chat.id) !== this.config.credentials.allowedChatId) {
            continue;
          }
        }

        // Skip commands (handled separately)
        if (msg.text.startsWith("/")) {
          continue;
        }

        try {
          // Create or update conversation (thread-first model)
          const isCreated = this.upsertConversation(msg);
          if (isCreated) {
            result.itemsCreated++;
          } else {
            result.itemsUpdated++;
          }
        } catch (err) {
          result.errors.push(`Failed to process message ${msg.message_id}: ${err}`);
        }
      }

      // Save sync state
      updateSyncState({
        source: this.source,
        cursor: String(offset),
        last_sync: new Date().toISOString(),
        last_successful_sync: new Date().toISOString(),
        status: "success",
        items_synced: (syncState?.items_synced || 0) + result.itemsProcessed,
        consecutive_failures: 0,
      });

      result.cursor = String(offset);
      result.success = true;
    } catch (err) {
      result.errors.push(`Sync failed: ${err}`);

      // Record failure
      const syncState = getSyncState(this.source);
      updateSyncState({
        source: this.source,
        status: "error",
        error_message: String(err),
        consecutive_failures: (syncState?.consecutive_failures || 0) + 1,
      });
    }

    return result;
  }

  /**
   * Upsert conversation and add message
   * Returns true if new conversation created
   */
  private upsertConversation(msg: TelegramMessage): boolean {
    // Build conversation ID from chat
    const chatId = String(msg.chat.id);
    const sourceId = `chat_${chatId}`;

    // Get sender info
    const senderName = msg.from
      ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ")
      : "Unknown";

    // Build intake item
    const item: Partial<IntakeItem> & { source: string; source_id: string; type: string } = {
      zone: this.zone,
      source: this.source,
      source_id: sourceId,
      type: "conversation",
      subject: msg.chat.title || `Chat with ${senderName}`,
      body: msg.text,
      from_name: senderName,
      from_user_id: msg.from ? String(msg.from.id) : undefined,
      created_at: new Date(msg.date * 1000).toISOString(),
      updated_at: new Date(msg.date * 1000).toISOString(),
      content_hash: hashContent(msg.text || ""),
      metadata: JSON.stringify({
        chat_id: msg.chat.id,
        chat_type: msg.chat.type,
        username: msg.from?.username,
      }),
    };

    // Upsert the intake record
    const intakeId = upsertIntake(item);

    // Add message to thread
    const message: Message = {
      id: generateId(),
      intake_id: intakeId,
      source_message_id: String(msg.message_id),
      timestamp: new Date(msg.date * 1000).toISOString(),
      sender_name: senderName,
      sender_address: msg.from?.username,
      content: msg.text || "",
      metadata: JSON.stringify({
        reply_to: msg.reply_to_message?.message_id,
      }),
    };

    addMessage(message);

    // Update context with recent thread history
    const context = buildThreadContext(intakeId, 10);
    upsertIntake({
      ...item,
      context,
      message_count: (item.message_count || 0) + 1,
    });

    return true; // We use upsert, so we can't easily tell if created vs updated
  }

  /**
   * Transform raw Telegram message to IntakeItem
   */
  protected transformItem(sourceData: unknown): IntakeItem {
    const msg = sourceData as TelegramMessage;
    const senderName = msg.from
      ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ")
      : "Unknown";

    return {
      id: generateId(),
      zone: this.zone,
      source: this.source,
      source_id: `chat_${msg.chat.id}`,
      type: "conversation",
      subject: msg.chat.title || `Chat with ${senderName}`,
      body: msg.text,
      from_name: senderName,
      from_user_id: msg.from ? String(msg.from.id) : undefined,
      created_at: new Date(msg.date * 1000).toISOString(),
      updated_at: new Date(msg.date * 1000).toISOString(),
      content_hash: hashContent(msg.text || ""),
      metadata: JSON.stringify({
        chat_id: msg.chat.id,
        chat_type: msg.chat.type,
      }),
    };
  }

  /**
   * Transform messages (not used for Telegram - handled inline)
   */
  protected transformMessages(_sourceData: unknown): Message[] {
    return [];
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create Telegram adapter from environment or BWS secrets
 */
export async function createTelegramAdapter(zone: Zone): Promise<TelegramAdapter | null> {
  // Try environment variables first
  let botToken = process.env.TELEGRAM_BOT_TOKEN;
  let allowedChatId = process.env.TELEGRAM_CHAT_ID;

  // Try BWS if not in environment
  if (!botToken) {
    try {
      const { execSync } = await import("child_process");
      const secrets = JSON.parse(
        execSync("bws secret list 2>/dev/null", { encoding: "utf-8" })
      ) as Array<{ key: string; value: string }>;

      const tokenSecret = secrets.find((s) => s.key === "telegram-bot-token");
      const chatSecret = secrets.find((s) => s.key === "telegram-chat-id");

      botToken = tokenSecret?.value;
      allowedChatId = chatSecret?.value;
    } catch {
      console.warn("BWS not available, telegram adapter requires TELEGRAM_BOT_TOKEN env var");
      return null;
    }
  }

  if (!botToken) {
    console.warn("No Telegram bot token configured");
    return null;
  }

  return new TelegramAdapter({
    zone,
    source: "telegram",
    enabled: true,
    credentials: {
      botToken,
      allowedChatId,
    },
  });
}

// Register adapter
registerAdapter("telegram", TelegramAdapter as unknown as typeof BaseAdapter);
