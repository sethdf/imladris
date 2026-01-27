/**
 * MS365 Email Adapter
 *
 * Syncs email from Microsoft 365 via Graph API into the intake system.
 * Authentication handled via auth-keeper.sh PowerShell integration.
 * Thread-first model: conversations are grouped by ConversationId.
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
import { BaseAdapter, type AdapterConfig, type SyncResult, registerAdapter } from "./base.js";

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

interface MS365Message {
  Id: string;
  Subject: string;
  From: {
    EmailAddress: {
      Name: string;
      Address: string;
    };
  };
  ReceivedDateTime: string;
  Body?: {
    Content: string;
    ContentType: string;
  };
  BodyPreview: string;
  ConversationId: string;
  IsRead: boolean;
  ToRecipients?: Array<{ EmailAddress: { Name: string; Address: string } }>;
  CcRecipients?: Array<{ EmailAddress: { Name: string; Address: string } }>;
  HasAttachments?: boolean;
  Importance?: string;
  InternetMessageId?: string;
}

interface MS365Config extends AdapterConfig {
  credentials: {
    user?: string; // MS365 user email, defaults from env
  };
}

// =============================================================================
// MS365 Email Adapter
// =============================================================================

export class MS365EmailAdapter extends BaseAdapter {
  constructor(config: MS365Config) {
    super(config);
  }

  private get ms365Config(): MS365Config {
    return this.config as MS365Config;
  }

  private getUser(): string {
    return this.ms365Config.credentials.user || process.env.MS365_USER || "";
  }

  /**
   * Execute PowerShell command via auth-keeper
   */
  private async runPowerShell(command: string): Promise<string> {
    const tempFile = `/tmp/ms365-${Date.now()}.ps1`;
    await Bun.write(tempFile, command);

    try {
      const result = await $`bash -c 'source ${AUTH_KEEPER_PATH} && _ak_ms365_cmd "$(cat ${tempFile})"'`.text();
      return result;
    } finally {
      await $`rm -f ${tempFile}`.quiet();
    }
  }

  /**
   * Validate MS365 connectivity
   */
  async validate(): Promise<boolean> {
    const user = this.getUser();
    if (!user) return false;

    const psCommand = `
Get-MgUser -UserId '${user}' | Select-Object UserPrincipalName | ConvertTo-Json
`.trim();

    try {
      const result = await this.runPowerShell(psCommand);
      const parsed = JSON.parse(result);
      return !!parsed?.UserPrincipalName;
    } catch {
      return false;
    }
  }

  /**
   * Sync emails from MS365
   */
  async sync(cursor?: string): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      itemsProcessed: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      errors: [],
    };

    const user = this.getUser();
    if (!user) {
      result.errors.push("MS365_USER not configured");
      return result;
    }

    try {
      // Get unread emails from inbox
      const emails = await this.getUnreadEmails(100);
      console.log(`Processing ${emails.length} MS365 emails...`);

      // Group by conversation for thread-first model
      const conversations = new Map<string, MS365Message[]>();
      for (const email of emails) {
        const convId = email.ConversationId || email.Id;
        if (!conversations.has(convId)) {
          conversations.set(convId, []);
        }
        conversations.get(convId)!.push(email);
      }

      // Process each conversation
      for (const [convId, messages] of conversations) {
        result.itemsProcessed++;

        try {
          // Sort by date, oldest first
          messages.sort((a, b) =>
            new Date(a.ReceivedDateTime).getTime() - new Date(b.ReceivedDateTime).getTime()
          );

          const isCreated = this.upsertConversation(convId, messages);
          if (isCreated) {
            result.itemsCreated++;
          } else {
            result.itemsUpdated++;
          }
        } catch (err) {
          result.errors.push(`Failed to process conversation ${convId}: ${err}`);
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
   * Get unread emails from inbox
   */
  private async getUnreadEmails(limit: number): Promise<MS365Message[]> {
    const user = this.getUser();

    const psCommand = `
$inbox = Get-MgUserMailFolder -UserId '${user}' | Where-Object { $_.DisplayName -eq 'Inbox' }
Get-MgUserMailFolderMessage -UserId '${user}' -MailFolderId $inbox.Id -Filter 'isRead eq false' -Top ${limit} -Select 'id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,toRecipients,ccRecipients,hasAttachments,importance' | ConvertTo-Json -Depth 5
`.trim();

    const result = await this.runPowerShell(psCommand);

    try {
      const parsed = JSON.parse(result);
      return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    } catch {
      return [];
    }
  }

  /**
   * Upsert conversation and add messages
   */
  private upsertConversation(convId: string, messages: MS365Message[]): boolean {
    const latestMsg = messages[messages.length - 1];
    const firstMsg = messages[0];

    // Build source ID from conversation
    const sourceId = `conv_${convId}`;

    // Get participants
    const participants = new Set<string>();
    for (const msg of messages) {
      if (msg.From?.EmailAddress?.Address) {
        participants.add(msg.From.EmailAddress.Address);
      }
      for (const to of msg.ToRecipients || []) {
        if (to.EmailAddress?.Address) {
          participants.add(to.EmailAddress.Address);
        }
      }
    }

    // Build intake item
    const item: Partial<IntakeItem> & { source: string; source_id: string; type: string } = {
      zone: this.zone,
      source: this.source,
      source_id: sourceId,
      type: "email",
      subject: latestMsg.Subject || "(no subject)",
      body: latestMsg.BodyPreview || "",
      from_name: latestMsg.From?.EmailAddress?.Name,
      from_address: latestMsg.From?.EmailAddress?.Address,
      participants: Array.from(participants).join(", "),
      created_at: new Date(firstMsg.ReceivedDateTime).toISOString(),
      updated_at: new Date(latestMsg.ReceivedDateTime).toISOString(),
      content_hash: hashContent(latestMsg.BodyPreview || ""),
      read_status: latestMsg.IsRead ? "read" : "unread",
      metadata: JSON.stringify({
        conversation_id: convId,
        has_attachments: latestMsg.HasAttachments,
        importance: latestMsg.Importance,
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
        source_message_id: msg.Id,
        timestamp: new Date(msg.ReceivedDateTime).toISOString(),
        sender_name: msg.From?.EmailAddress?.Name,
        sender_address: msg.From?.EmailAddress?.Address,
        content: msg.BodyPreview || "",
        metadata: JSON.stringify({
          subject: msg.Subject,
          has_attachments: msg.HasAttachments,
          importance: msg.Importance,
        }),
      };

      addMessage(message);
    }

    // Update context
    const context = buildThreadContext(intakeId, 10);
    upsertIntake({
      ...item,
      context,
      message_count: messages.length,
    });

    return true;
  }

  protected transformItem(sourceData: unknown): IntakeItem {
    const msg = sourceData as MS365Message;
    return {
      id: generateId(),
      zone: this.zone,
      source: this.source,
      source_id: `msg_${msg.Id}`,
      type: "email",
      subject: msg.Subject || "(no subject)",
      body: msg.BodyPreview || "",
      from_name: msg.From?.EmailAddress?.Name,
      from_address: msg.From?.EmailAddress?.Address,
      created_at: new Date(msg.ReceivedDateTime).toISOString(),
      updated_at: new Date(msg.ReceivedDateTime).toISOString(),
      content_hash: hashContent(msg.BodyPreview || ""),
    };
  }

  protected transformMessages(_sourceData: unknown): Message[] {
    return [];
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export async function createMS365EmailAdapter(zone: Zone): Promise<MS365EmailAdapter | null> {
  const user = process.env.MS365_USER;

  if (!user) {
    console.warn("MS365_USER not set, email-ms365 adapter not available");
    return null;
  }

  return new MS365EmailAdapter({
    zone,
    source: "email-ms365",
    enabled: true,
    credentials: { user },
  });
}

// Register adapter
registerAdapter("email-ms365", MS365EmailAdapter as unknown as typeof BaseAdapter);
