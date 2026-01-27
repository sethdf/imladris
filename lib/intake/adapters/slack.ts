/**
 * Slack Adapter
 *
 * Syncs messages from Slack via slackdump SQLite archive into the intake system.
 * The archive is populated by a separate cron job running slackdump.
 * Thread-first model: conversations are grouped by channel.
 */

import { $ } from "bun";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
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
import { BaseAdapter, type AdapterConfig, type SyncResult, registerAdapter, upsertAndTriage } from "./base.js";

// =============================================================================
// Configuration
// =============================================================================

function getArchivePath(): string {
  return process.env.SLACK_ARCHIVE || join(homedir(), "slack-archive/slackdump.sqlite");
}

// =============================================================================
// Types
// =============================================================================

interface SlackMessage {
  id: string;
  timestamp: string;
  from_name: string;
  from_address: string;
  subject: string;
  body_preview: string;
  thread_id: string;
  channel_id: string;
  channel_name: string;
  channel_type: "channel" | "im" | "mpim";
  user_id: string;
}

interface SlackConfig extends AdapterConfig {
  credentials: {
    archivePath?: string;
  };
}

// =============================================================================
// Slack Adapter
// =============================================================================

export class SlackAdapter extends BaseAdapter {
  constructor(config: SlackConfig) {
    super(config);
  }

  private get slackConfig(): SlackConfig {
    return this.config as SlackConfig;
  }

  private getArchivePath(): string {
    return this.slackConfig.credentials.archivePath || getArchivePath();
  }

  /**
   * Check if slackdump archive exists
   */
  private archiveExists(): boolean {
    return existsSync(this.getArchivePath());
  }

  /**
   * Run a SQLite query on the slackdump archive
   */
  private async query<T>(sql: string): Promise<T[]> {
    const archivePath = this.getArchivePath();

    if (!this.archiveExists()) {
      console.error(`Slack archive not found: ${archivePath}`);
      return [];
    }

    try {
      const result = await $`sqlite3 -json ${archivePath} ${sql}`.text();
      return JSON.parse(result) as T[];
    } catch (e) {
      console.error(`SQLite query failed: ${e}`);
      return [];
    }
  }

  /**
   * Validate Slack archive connectivity
   */
  async validate(): Promise<boolean> {
    if (!this.archiveExists()) return false;

    try {
      const result = await this.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM MESSAGE LIMIT 1;");
      return result.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Sync messages from Slack archive
   */
  async sync(_cursor?: string): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      itemsProcessed: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      errors: [],
    };

    if (!this.archiveExists()) {
      result.errors.push(`Slack archive not found: ${this.getArchivePath()}`);
      return result;
    }

    try {
      // Get recent messages (last 24 hours)
      const messages = await this.getRecentMessages(100, 24);
      console.log(`Processing ${messages.length} Slack messages...`);

      // Group by channel for thread-first model
      const channels = new Map<string, SlackMessage[]>();
      for (const msg of messages) {
        const channelId = msg.channel_id;
        if (!channels.has(channelId)) {
          channels.set(channelId, []);
        }
        channels.get(channelId)!.push(msg);
      }

      // Process each channel
      for (const [channelId, channelMessages] of channels) {
        result.itemsProcessed++;

        try {
          // Sort by timestamp
          channelMessages.sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );

          const isCreated = await this.upsertConversation(channelId, channelMessages);
          if (isCreated) {
            result.itemsCreated++;
          } else {
            result.itemsUpdated++;
          }
        } catch (err) {
          result.errors.push(`Failed to process channel ${channelId}: ${err}`);
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
   * Get recent messages from Slack archive
   */
  private async getRecentMessages(limit: number, hoursAgo: number): Promise<SlackMessage[]> {
    const sql = `
      SELECT DISTINCT
        m.CHANNEL_ID || '-' || m.TS AS id,
        datetime(CAST(m.TS AS REAL), 'unixepoch') AS timestamp,
        COALESCE(json_extract(u.DATA, '$.real_name'), u.USERNAME, json_extract(m.DATA, '$.user'), 'Unknown') AS from_name,
        json_extract(m.DATA, '$.user') AS from_address,
        CASE
          WHEN c.ID LIKE 'D%' THEN 'DM: ' || COALESCE(json_extract(u.DATA, '$.real_name'), u.USERNAME, 'Unknown')
          WHEN c.ID LIKE 'G%' THEN 'Group: ' || COALESCE(c.NAME, 'Private')
          ELSE '#' || COALESCE(c.NAME, 'Unknown')
        END AS subject,
        m.TXT AS body_preview,
        COALESCE(m.THREAD_TS, m.TS) AS thread_id,
        c.ID AS channel_id,
        c.NAME AS channel_name,
        CASE
          WHEN c.ID LIKE 'D%' THEN 'im'
          WHEN c.ID LIKE 'G%' THEN 'mpim'
          ELSE 'channel'
        END AS channel_type,
        json_extract(m.DATA, '$.user') AS user_id
      FROM MESSAGE m
      LEFT JOIN S_USER u ON json_extract(m.DATA, '$.user') = u.ID
      LEFT JOIN CHANNEL c ON m.CHANNEL_ID = c.ID
      WHERE datetime(CAST(m.TS AS REAL), 'unixepoch') > datetime('now', '-${hoursAgo} hours')
        AND m.TXT IS NOT NULL
        AND m.TXT <> ''
      GROUP BY m.CHANNEL_ID, m.TS
      ORDER BY m.TS DESC
      LIMIT ${limit};
    `;

    return this.query<SlackMessage>(sql);
  }

  /**
   * Upsert conversation and add messages
   */
  private async upsertConversation(channelId: string, messages: SlackMessage[]): Promise<boolean> {
    const latestMsg = messages[messages.length - 1];
    const firstMsg = messages[0];

    const sourceId = `channel_${channelId}`;

    // Get participants
    const participants = new Set<string>();
    for (const msg of messages) {
      if (msg.from_name) participants.add(msg.from_name);
    }

    // Build intake item
    const item: Partial<IntakeItem> & { source: string; source_id: string; type: string } = {
      zone: this.zone,
      source: this.source,
      source_id: sourceId,
      type: "chat",
      subject: latestMsg.subject || `#${latestMsg.channel_name || "unknown"}`,
      body: latestMsg.body_preview || "",
      from_name: latestMsg.from_name,
      from_address: latestMsg.user_id,
      participants: Array.from(participants).join(", "),
      created_at: new Date(firstMsg.timestamp).toISOString(),
      updated_at: new Date(latestMsg.timestamp).toISOString(),
      content_hash: hashContent(latestMsg.body_preview || ""),
      read_status: "unread", // Slackdump doesn't track read status
      metadata: JSON.stringify({
        channel_id: channelId,
        channel_name: latestMsg.channel_name,
        channel_type: latestMsg.channel_type,
        message_count: messages.length,
      }),
    };

    // Upsert intake record
    const intakeId = upsertIntake(item);

    // Add messages to thread
    for (const msg of messages) {
      const message: Message = {
        id: generateId(),
        intake_id: intakeId,
        source_message_id: msg.id,
        timestamp: new Date(msg.timestamp).toISOString(),
        sender_name: msg.from_name,
        sender_address: msg.user_id,
        content: msg.body_preview || "",
        metadata: JSON.stringify({
          thread_id: msg.thread_id,
          channel_type: msg.channel_type,
        }),
      };

      addMessage(message);
    }

    // Update context and run triage
    const context = buildThreadContext(intakeId, 10);
    await upsertAndTriage({
      ...item,
      context,
      message_count: messages.length,
    });

    return true;
  }

  protected transformItem(sourceData: unknown): IntakeItem {
    const msg = sourceData as SlackMessage;
    return {
      id: generateId(),
      zone: this.zone,
      source: this.source,
      source_id: `msg_${msg.id}`,
      type: "chat",
      subject: msg.subject || `#${msg.channel_name || "unknown"}`,
      body: msg.body_preview || "",
      from_name: msg.from_name,
      from_address: msg.user_id,
      created_at: new Date(msg.timestamp).toISOString(),
      updated_at: new Date(msg.timestamp).toISOString(),
      content_hash: hashContent(msg.body_preview || ""),
    };
  }

  protected transformMessages(_sourceData: unknown): Message[] {
    return [];
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export async function createSlackAdapter(zone: Zone): Promise<SlackAdapter | null> {
  const archivePath = getArchivePath();

  if (!existsSync(archivePath)) {
    console.warn(`Slack archive not found at ${archivePath}, slack adapter not available`);
    return null;
  }

  return new SlackAdapter({
    zone,
    source: "slack",
    enabled: true,
    credentials: { archivePath },
  });
}

// Register adapter
registerAdapter("slack", SlackAdapter as unknown as typeof BaseAdapter);
