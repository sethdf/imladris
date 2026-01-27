/**
 * Signal Adapter
 *
 * Syncs messages from Signal CLI REST API into the intake system.
 * Thread-first model: each conversation is a thread.
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

interface SignalMessage {
  envelope: {
    source?: string;
    sourceNumber?: string;
    sourceName?: string;
    sourceUuid?: string;
    timestamp: number; // milliseconds
    dataMessage?: {
      message?: string;
      timestamp?: number;
      groupInfo?: {
        groupId: string;
        type: string;
      };
    };
  };
}

interface SignalConfig extends AdapterConfig {
  credentials: {
    apiUrl: string;
    phoneNumber: string;
  };
}

// =============================================================================
// Signal Adapter
// =============================================================================

export class SignalAdapter extends BaseAdapter {
  private config: SignalConfig;

  constructor(config: SignalConfig) {
    super(config);
    this.config = config;
  }

  /**
   * Validate Signal CLI API connectivity
   */
  async validate(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.credentials.apiUrl}/v1/about`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Sync messages from Signal
   */
  async sync(_cursor?: string): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      itemsProcessed: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      errors: [],
    };

    try {
      const { apiUrl, phoneNumber } = this.config.credentials;

      // Receive messages (this also acknowledges them in signal-cli)
      const response = await fetch(`${apiUrl}/v1/receive/${encodeURIComponent(phoneNumber)}`, {
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        result.errors.push(`Signal API returned ${response.status}`);
        return result;
      }

      const messages = await response.json() as SignalMessage[];

      if (!Array.isArray(messages) || messages.length === 0) {
        result.success = true;
        return result;
      }

      console.log(`Processing ${messages.length} Signal messages...`);

      for (const msg of messages) {
        result.itemsProcessed++;

        // Skip messages without text content
        const text = msg.envelope.dataMessage?.message;
        if (!text) continue;

        // Skip commands (handled separately)
        if (text.startsWith("/")) continue;

        try {
          const isCreated = this.upsertConversation(msg);
          if (isCreated) {
            result.itemsCreated++;
          } else {
            result.itemsUpdated++;
          }
        } catch (err) {
          result.errors.push(`Failed to process message: ${err}`);
        }
      }

      // Update sync state
      const syncState = getSyncState(this.source);
      updateSyncState({
        source: this.source,
        last_sync: new Date().toISOString(),
        last_successful_sync: new Date().toISOString(),
        status: "success",
        items_synced: (syncState?.items_synced || 0) + result.itemsProcessed,
        consecutive_failures: 0,
      });

      result.success = true;
    } catch (err) {
      result.errors.push(`Sync failed: ${err}`);

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
   */
  private upsertConversation(msg: SignalMessage): boolean {
    const envelope = msg.envelope;
    const text = envelope.dataMessage?.message || "";

    // Build conversation ID
    // For groups: use groupId, for direct: use source number
    const groupId = envelope.dataMessage?.groupInfo?.groupId;
    const sourceId = groupId ? `group_${groupId}` : `dm_${envelope.sourceNumber || envelope.sourceUuid}`;

    // Sender info
    const senderName = envelope.sourceName || envelope.sourceNumber || "Unknown";

    // Timestamp (Signal uses milliseconds)
    const timestamp = new Date(envelope.timestamp).toISOString();

    // Build intake item
    const item: Partial<IntakeItem> & { source: string; source_id: string; type: string } = {
      zone: this.zone,
      source: this.source,
      source_id: sourceId,
      type: "conversation",
      subject: groupId ? `Signal Group` : `Chat with ${senderName}`,
      body: text,
      from_name: senderName,
      from_address: envelope.sourceNumber,
      from_user_id: envelope.sourceUuid,
      created_at: timestamp,
      updated_at: timestamp,
      content_hash: hashContent(text),
      metadata: JSON.stringify({
        source_number: envelope.sourceNumber,
        source_uuid: envelope.sourceUuid,
        group_id: groupId,
      }),
    };

    // Upsert intake record
    const intakeId = upsertIntake(item);

    // Add message to thread
    const message: Message = {
      id: generateId(),
      intake_id: intakeId,
      source_message_id: String(envelope.timestamp),
      timestamp,
      sender_name: senderName,
      sender_address: envelope.sourceNumber,
      content: text,
    };

    addMessage(message);

    // Update context
    const context = buildThreadContext(intakeId, 10);
    upsertIntake({
      ...item,
      context,
      message_count: (item.message_count || 0) + 1,
    });

    return true;
  }

  /**
   * Transform raw Signal message to IntakeItem
   */
  protected transformItem(sourceData: unknown): IntakeItem {
    const msg = sourceData as SignalMessage;
    const envelope = msg.envelope;
    const text = envelope.dataMessage?.message || "";

    const groupId = envelope.dataMessage?.groupInfo?.groupId;
    const sourceId = groupId ? `group_${groupId}` : `dm_${envelope.sourceNumber || envelope.sourceUuid}`;
    const senderName = envelope.sourceName || envelope.sourceNumber || "Unknown";

    return {
      id: generateId(),
      zone: this.zone,
      source: this.source,
      source_id: sourceId,
      type: "conversation",
      subject: groupId ? `Signal Group` : `Chat with ${senderName}`,
      body: text,
      from_name: senderName,
      from_address: envelope.sourceNumber,
      from_user_id: envelope.sourceUuid,
      created_at: new Date(envelope.timestamp).toISOString(),
      updated_at: new Date(envelope.timestamp).toISOString(),
      content_hash: hashContent(text),
    };
  }

  /**
   * Transform messages (not used - handled inline)
   */
  protected transformMessages(_sourceData: unknown): Message[] {
    return [];
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create Signal adapter from environment or BWS secrets
 */
export async function createSignalAdapter(zone: Zone): Promise<SignalAdapter | null> {
  // Environment variables
  let apiUrl = process.env.SIGNAL_API_URL || "http://127.0.0.1:8080";
  let phoneNumber = process.env.SIGNAL_PHONE;

  // Try BWS if phone not in environment
  if (!phoneNumber) {
    try {
      const { execSync } = await import("child_process");
      const secrets = JSON.parse(
        execSync("bws secret list 2>/dev/null", { encoding: "utf-8" })
      ) as Array<{ key: string; value: string }>;

      const phoneSecret = secrets.find((s) => s.key === "signal-phone");
      phoneNumber = phoneSecret?.value;
    } catch {
      console.warn("BWS not available, signal adapter requires SIGNAL_PHONE env var");
      return null;
    }
  }

  if (!phoneNumber) {
    console.warn("No Signal phone number configured");
    return null;
  }

  return new SignalAdapter({
    zone,
    source: "signal",
    enabled: true,
    credentials: {
      apiUrl,
      phoneNumber,
    },
  });
}

// Register adapter
registerAdapter("signal", SignalAdapter as unknown as typeof BaseAdapter);
