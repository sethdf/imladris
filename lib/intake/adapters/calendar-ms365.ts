/**
 * MS365 Calendar Adapter
 *
 * Syncs calendar events from Microsoft 365 via Graph API into the intake system.
 * Authentication handled via auth-keeper.sh PowerShell integration.
 * Events are imported as individual intake items with meeting context.
 */

import { $ } from "bun";
import { homedir } from "os";
import { join } from "path";
import {
  upsertIntake,
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

interface MS365CalendarEvent {
  Id: string;
  Subject: string;
  Start: {
    DateTime: string;
    TimeZone: string;
  };
  End: {
    DateTime: string;
    TimeZone: string;
  };
  Location?: {
    DisplayName?: string;
  };
  Organizer?: {
    EmailAddress: {
      Name: string;
      Address: string;
    };
  };
  Attendees?: Array<{
    EmailAddress: {
      Name: string;
      Address: string;
    };
    Status?: {
      Response: string;
    };
  }>;
  Body?: {
    Content: string;
    ContentType: string;
  };
  BodyPreview?: string;
  IsAllDay?: boolean;
  IsCancelled?: boolean;
  IsOrganizer?: boolean;
  ResponseStatus?: {
    Response: string;
  };
  OnlineMeetingUrl?: string;
  WebLink?: string;
}

interface MS365CalendarConfig extends AdapterConfig {
  credentials: {
    user?: string;
  };
}

// =============================================================================
// MS365 Calendar Adapter
// =============================================================================

export class MS365CalendarAdapter extends BaseAdapter {
  constructor(config: MS365CalendarConfig) {
    super(config);
  }

  private get calendarConfig(): MS365CalendarConfig {
    return this.config as MS365CalendarConfig;
  }

  private getUser(): string {
    return this.calendarConfig.credentials.user || process.env.MS365_USER || "";
  }

  /**
   * Execute PowerShell command via auth-keeper
   */
  private async runPowerShell(command: string): Promise<string> {
    const tempFile = `/tmp/ms365-cal-${Date.now()}.ps1`;
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
Get-MgUserCalendar -UserId '${user}' | Select-Object Name | ConvertTo-Json
`.trim();

    try {
      const result = await this.runPowerShell(psCommand);
      const parsed = JSON.parse(result);
      return !!parsed;
    } catch {
      return false;
    }
  }

  /**
   * Sync calendar events from MS365
   */
  async sync(_cursor?: string): Promise<SyncResult> {
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
      // Get upcoming events (next 30 days)
      const events = await this.getUpcomingEvents(100);
      console.log(`Processing ${events.length} MS365 calendar events...`);

      for (const event of events) {
        result.itemsProcessed++;

        try {
          const isCreated = this.upsertEvent(event);
          if (isCreated) {
            result.itemsCreated++;
          } else {
            result.itemsUpdated++;
          }
        } catch (err) {
          result.errors.push(`Failed to process event ${event.Id}: ${err}`);
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
   * Get upcoming calendar events
   */
  private async getUpcomingEvents(limit: number): Promise<MS365CalendarEvent[]> {
    const user = this.getUser();
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const psCommand = `
$startTime = '${now}'
$endTime = '${future}'
Get-MgUserCalendarView -UserId '${user}' -StartDateTime $startTime -EndDateTime $endTime -Top ${limit} -Select 'id,subject,start,end,location,organizer,attendees,bodyPreview,isAllDay,isCancelled,isOrganizer,responseStatus,onlineMeetingUrl,webLink' | ConvertTo-Json -Depth 5
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
   * Upsert calendar event
   */
  private upsertEvent(event: MS365CalendarEvent): boolean {
    const sourceId = `event_${event.Id}`;

    // Get participants
    const participants = new Set<string>();
    if (event.Organizer?.EmailAddress?.Address) {
      participants.add(event.Organizer.EmailAddress.Address);
    }
    for (const attendee of event.Attendees || []) {
      if (attendee.EmailAddress?.Address) {
        participants.add(attendee.EmailAddress.Address);
      }
    }

    // Build event summary
    const startDate = new Date(event.Start.DateTime);
    const endDate = new Date(event.End.DateTime);
    const duration = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60));
    const location = event.Location?.DisplayName || "No location";

    const body = event.BodyPreview || "";
    const summary = `${event.IsAllDay ? "All day" : `${duration} min`} | ${location}${event.OnlineMeetingUrl ? " | Online meeting" : ""}`;

    // Build intake item
    const item: Partial<IntakeItem> & { source: string; source_id: string; type: string } = {
      zone: this.zone,
      source: this.source,
      source_id: sourceId,
      type: "calendar",
      subject: event.Subject || "(no subject)",
      body: `${summary}\n\n${body}`.trim(),
      from_name: event.Organizer?.EmailAddress?.Name,
      from_address: event.Organizer?.EmailAddress?.Address,
      participants: Array.from(participants).join(", "),
      created_at: new Date(event.Start.DateTime).toISOString(),
      updated_at: new Date().toISOString(),
      content_hash: hashContent(`${event.Subject}${event.Start.DateTime}`),
      read_status: event.ResponseStatus?.Response === "accepted" ? "read" : "unread",
      metadata: JSON.stringify({
        event_id: event.Id,
        start: event.Start,
        end: event.End,
        location: event.Location?.DisplayName,
        is_all_day: event.IsAllDay,
        is_cancelled: event.IsCancelled,
        is_organizer: event.IsOrganizer,
        response_status: event.ResponseStatus?.Response,
        online_meeting_url: event.OnlineMeetingUrl,
        web_link: event.WebLink,
        attendee_count: event.Attendees?.length || 0,
      }),
    };

    // Upsert intake record
    upsertIntake(item);

    return true;
  }

  protected transformItem(sourceData: unknown): IntakeItem {
    const event = sourceData as MS365CalendarEvent;
    return {
      id: generateId(),
      zone: this.zone,
      source: this.source,
      source_id: `event_${event.Id}`,
      type: "calendar",
      subject: event.Subject || "(no subject)",
      body: event.BodyPreview || "",
      from_name: event.Organizer?.EmailAddress?.Name,
      from_address: event.Organizer?.EmailAddress?.Address,
      created_at: new Date(event.Start.DateTime).toISOString(),
      updated_at: new Date().toISOString(),
      content_hash: hashContent(`${event.Subject}${event.Start.DateTime}`),
    };
  }

  protected transformMessages(_sourceData: unknown): Message[] {
    // Calendar events don't have message threads
    return [];
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export async function createMS365CalendarAdapter(zone: Zone): Promise<MS365CalendarAdapter | null> {
  const user = process.env.MS365_USER;

  if (!user) {
    console.warn("MS365_USER not set, calendar-ms365 adapter not available");
    return null;
  }

  return new MS365CalendarAdapter({
    zone,
    source: "calendar-ms365",
    enabled: true,
    credentials: { user },
  });
}

// Register adapter
registerAdapter("calendar-ms365", MS365CalendarAdapter as unknown as typeof BaseAdapter);
