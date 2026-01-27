/**
 * Gmail Adapter
 *
 * Syncs email from Gmail via Gmail API into the intake system.
 * Authentication handled via auth-keeper.sh Google OAuth integration.
 * Thread-first model: conversations are grouped by threadId.
 */

import { $ } from "bun";
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

const AUTH_KEEPER_PATH = join(
  homedir(),
  "repos/github.com/sethdf/imladris/scripts/auth-keeper.sh"
);

// =============================================================================
// Types
// =============================================================================

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet: string;
  internalDate?: string;
  payload?: {
    headers: Array<{ name: string; value: string }>;
  };
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
}

interface GmailConfig extends AdapterConfig {
  credentials: Record<string, string>;
}

// =============================================================================
// Gmail Adapter
// =============================================================================

export class GmailAdapter extends BaseAdapter {
  constructor(config: GmailConfig) {
    super(config);
  }

  /**
   * Call Gmail API via auth-keeper
   */
  private async callGmailApi(method: string, endpoint: string): Promise<unknown> {
    const command = `
source ${AUTH_KEEPER_PATH}
token=$(_ak_google_get_access_token) || exit 1
curl -s -X ${method} "https://www.googleapis.com/${endpoint}" \\
  -H "Authorization: Bearer $token"
`.trim();

    const result = await $`bash -c ${command}`.text();

    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }

  /**
   * Get header value from Gmail message
   */
  private getHeader(msg: GmailMessage, name: string): string | null {
    const header = msg.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase()
    );
    return header?.value || null;
  }

  /**
   * Parse email address from "Name <email@example.com>" format
   */
  private parseEmailAddress(from: string | null): { name: string | null; address: string | null } {
    if (!from) return { name: null, address: null };

    const match = from.match(/^(.+?)\s*<(.+?)>$/);
    if (match) {
      return { name: match[1].trim(), address: match[2].trim() };
    }

    if (from.includes("@")) {
      return { name: null, address: from.trim() };
    }

    return { name: from.trim(), address: null };
  }

  /**
   * Validate Gmail connectivity
   */
  async validate(): Promise<boolean> {
    try {
      const response = await this.callGmailApi("GET", "gmail/v1/users/me/profile") as { emailAddress?: string };
      return !!response.emailAddress;
    } catch {
      return false;
    }
  }

  /**
   * Sync emails from Gmail
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
      // Get unread emails
      const emails = await this.getUnreadEmails(100);
      console.log(`Processing ${emails.length} Gmail emails...`);

      // Group by thread
      const threads = new Map<string, GmailMessage[]>();
      for (const email of emails) {
        const threadId = email.threadId || email.id;
        if (!threads.has(threadId)) {
          threads.set(threadId, []);
        }
        threads.get(threadId)!.push(email);
      }

      // Process each thread
      for (const [threadId, messages] of threads) {
        result.itemsProcessed++;

        try {
          // Sort by date
          messages.sort((a, b) => {
            const dateA = parseInt(a.internalDate || "0");
            const dateB = parseInt(b.internalDate || "0");
            return dateA - dateB;
          });

          const isCreated = await this.upsertConversation(threadId, messages);
          if (isCreated) {
            result.itemsCreated++;
          } else {
            result.itemsUpdated++;
          }
        } catch (err) {
          result.errors.push(`Failed to process thread ${threadId}: ${err}`);
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
   * Get unread emails
   */
  private async getUnreadEmails(limit: number): Promise<GmailMessage[]> {
    const response = await this.callGmailApi(
      "GET",
      `gmail/v1/users/me/messages?maxResults=${limit}&q=is:unread+in:inbox`
    ) as GmailListResponse;

    if (!response.messages || response.messages.length === 0) {
      return [];
    }

    // Get full message details
    const messages: GmailMessage[] = [];
    for (const msg of response.messages.slice(0, limit)) {
      const full = await this.getEmailById(msg.id);
      if (full) {
        messages.push(full);
      }
    }

    return messages;
  }

  /**
   * Get email by ID
   */
  private async getEmailById(messageId: string): Promise<GmailMessage | null> {
    try {
      const response = await this.callGmailApi(
        "GET",
        `gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`
      ) as GmailMessage & { error?: { message: string } };

      if (response.error) {
        return null;
      }

      return response;
    } catch {
      return null;
    }
  }

  /**
   * Upsert conversation and add messages
   */
  private async upsertConversation(threadId: string, messages: GmailMessage[]): Promise<boolean> {
    const latestMsg = messages[messages.length - 1];
    const firstMsg = messages[0];

    const sourceId = `thread_${threadId}`;

    // Get participants
    const participants = new Set<string>();
    for (const msg of messages) {
      const from = this.parseEmailAddress(this.getHeader(msg, "From"));
      if (from.address) participants.add(from.address);

      const to = this.getHeader(msg, "To");
      if (to) {
        for (const addr of to.split(",")) {
          const parsed = this.parseEmailAddress(addr.trim());
          if (parsed.address) participants.add(parsed.address);
        }
      }
    }

    const latestFrom = this.parseEmailAddress(this.getHeader(latestMsg, "From"));
    const latestDate = this.getHeader(latestMsg, "Date");
    const firstDate = this.getHeader(firstMsg, "Date");

    // Build intake item
    const item: Partial<IntakeItem> & { source: string; source_id: string; type: string } = {
      zone: this.zone,
      source: this.source,
      source_id: sourceId,
      type: "email",
      subject: this.getHeader(latestMsg, "Subject") || "(no subject)",
      body: latestMsg.snippet || "",
      from_name: latestFrom.name || undefined,
      from_address: latestFrom.address || undefined,
      participants: Array.from(participants).join(", "),
      created_at: firstDate ? new Date(firstDate).toISOString() : new Date().toISOString(),
      updated_at: latestDate ? new Date(latestDate).toISOString() : new Date().toISOString(),
      content_hash: hashContent(latestMsg.snippet || ""),
      read_status: latestMsg.labelIds?.includes("UNREAD") ? "unread" : "read",
      metadata: JSON.stringify({
        thread_id: threadId,
        label_ids: latestMsg.labelIds,
        message_count: messages.length,
      }),
    };

    // Upsert intake record
    const intakeId = upsertIntake(item);

    // Add messages to thread
    for (const msg of messages) {
      const from = this.parseEmailAddress(this.getHeader(msg, "From"));
      const date = this.getHeader(msg, "Date");

      const message: Message = {
        id: generateId(),
        intake_id: intakeId,
        source_message_id: msg.id,
        timestamp: date ? new Date(date).toISOString() : new Date().toISOString(),
        sender_name: from.name || undefined,
        sender_address: from.address || undefined,
        content: msg.snippet || "",
        metadata: JSON.stringify({
          subject: this.getHeader(msg, "Subject"),
          label_ids: msg.labelIds,
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
    const msg = sourceData as GmailMessage;
    const from = this.parseEmailAddress(this.getHeader(msg, "From"));
    const date = this.getHeader(msg, "Date");

    return {
      id: generateId(),
      zone: this.zone,
      source: this.source,
      source_id: `msg_${msg.id}`,
      type: "email",
      subject: this.getHeader(msg, "Subject") || "(no subject)",
      body: msg.snippet || "",
      from_name: from.name || undefined,
      from_address: from.address || undefined,
      created_at: date ? new Date(date).toISOString() : new Date().toISOString(),
      updated_at: date ? new Date(date).toISOString() : new Date().toISOString(),
      content_hash: hashContent(msg.snippet || ""),
    };
  }

  protected transformMessages(_sourceData: unknown): Message[] {
    return [];
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export async function createGmailAdapter(zone: Zone): Promise<GmailAdapter | null> {
  // Gmail uses OAuth via auth-keeper, check if configured
  try {
    const testCommand = `source ${AUTH_KEEPER_PATH} && _ak_google_get_access_token >/dev/null 2>&1 && echo "ok"`;
    const result = await $`bash -c ${testCommand}`.text();
    if (!result.trim().includes("ok")) {
      console.warn("Gmail OAuth not configured, email-gmail adapter not available");
      return null;
    }
  } catch {
    console.warn("Gmail OAuth not configured, email-gmail adapter not available");
    return null;
  }

  return new GmailAdapter({
    zone,
    source: "email-gmail",
    enabled: true,
    credentials: {},
  });
}

// Register adapter
registerAdapter("email-gmail", GmailAdapter as unknown as typeof BaseAdapter);
