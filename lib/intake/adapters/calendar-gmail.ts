/**
 * Gmail Calendar Adapter
 *
 * Syncs calendar events from Google Calendar via API into the intake system.
 * Authentication handled via auth-keeper.sh Google OAuth integration.
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

interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  location?: string;
  organizer?: {
    displayName?: string;
    email: string;
  };
  attendees?: Array<{
    displayName?: string;
    email: string;
    responseStatus?: string;
  }>;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType: string;
      uri: string;
    }>;
  };
  created?: string;
  updated?: string;
}

interface GoogleCalendarListResponse {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
}

interface GoogleCalendarConfig extends AdapterConfig {
  credentials: Record<string, string>;
}

// =============================================================================
// Gmail Calendar Adapter
// =============================================================================

export class GmailCalendarAdapter extends BaseAdapter {
  constructor(config: GoogleCalendarConfig) {
    super(config);
  }

  /**
   * Call Google Calendar API via auth-keeper
   */
  private async callCalendarApi(endpoint: string): Promise<unknown> {
    const command = `
source ${AUTH_KEEPER_PATH}
token=$(_ak_google_get_access_token) || exit 1
curl -s "https://www.googleapis.com/calendar/v3/${endpoint}" \\
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
   * Validate Google Calendar connectivity
   */
  async validate(): Promise<boolean> {
    try {
      const response = await this.callCalendarApi("calendars/primary") as { id?: string; error?: unknown };
      return !!response.id && !response.error;
    } catch {
      return false;
    }
  }

  /**
   * Sync calendar events from Google Calendar
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
      // Get upcoming events (next 30 days)
      const events = await this.getUpcomingEvents(100);
      console.log(`Processing ${events.length} Google Calendar events...`);

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
          result.errors.push(`Failed to process event ${event.id}: ${err}`);
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
  private async getUpcomingEvents(limit: number): Promise<GoogleCalendarEvent[]> {
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const endpoint = `calendars/primary/events?timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(future)}&maxResults=${limit}&singleEvents=true&orderBy=startTime`;

    const response = await this.callCalendarApi(endpoint) as GoogleCalendarListResponse & { error?: { message: string } };

    if (response.error) {
      console.error(`Calendar API error: ${response.error.message}`);
      return [];
    }

    return response.items || [];
  }

  /**
   * Upsert calendar event
   */
  private upsertEvent(event: GoogleCalendarEvent): boolean {
    const sourceId = `event_${event.id}`;

    // Get participants
    const participants = new Set<string>();
    if (event.organizer?.email) {
      participants.add(event.organizer.email);
    }
    for (const attendee of event.attendees || []) {
      if (attendee.email) {
        participants.add(attendee.email);
      }
    }

    // Determine event times
    const isAllDay = !event.start.dateTime;
    const startTime = event.start.dateTime || event.start.date || "";
    const endTime = event.end.dateTime || event.end.date || "";

    // Build event summary
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    const duration = isAllDay ? 0 : Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60));
    const location = event.location || "No location";

    // Check for video meeting link
    const meetingUrl = event.hangoutLink ||
      event.conferenceData?.entryPoints?.find(ep => ep.entryPointType === "video")?.uri;

    const summary = `${isAllDay ? "All day" : `${duration} min`} | ${location}${meetingUrl ? " | Video meeting" : ""}`;

    // Build intake item
    const item: Partial<IntakeItem> & { source: string; source_id: string; type: string } = {
      zone: this.zone,
      source: this.source,
      source_id: sourceId,
      type: "calendar",
      subject: event.summary || "(no title)",
      body: `${summary}\n\n${event.description || ""}`.trim(),
      from_name: event.organizer?.displayName,
      from_address: event.organizer?.email,
      participants: Array.from(participants).join(", "),
      created_at: startTime ? new Date(startTime).toISOString() : new Date().toISOString(),
      updated_at: event.updated ? new Date(event.updated).toISOString() : new Date().toISOString(),
      content_hash: hashContent(`${event.summary}${startTime}`),
      read_status: "unread",
      metadata: JSON.stringify({
        event_id: event.id,
        start: event.start,
        end: event.end,
        location: event.location,
        is_all_day: isAllDay,
        status: event.status,
        html_link: event.htmlLink,
        meeting_url: meetingUrl,
        attendee_count: event.attendees?.length || 0,
      }),
    };

    // Upsert intake record
    upsertIntake(item);

    return true;
  }

  protected transformItem(sourceData: unknown): IntakeItem {
    const event = sourceData as GoogleCalendarEvent;
    const startTime = event.start.dateTime || event.start.date || "";

    return {
      id: generateId(),
      zone: this.zone,
      source: this.source,
      source_id: `event_${event.id}`,
      type: "calendar",
      subject: event.summary || "(no title)",
      body: event.description || "",
      from_name: event.organizer?.displayName,
      from_address: event.organizer?.email,
      created_at: startTime ? new Date(startTime).toISOString() : new Date().toISOString(),
      updated_at: new Date().toISOString(),
      content_hash: hashContent(`${event.summary}${startTime}`),
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

export async function createGmailCalendarAdapter(zone: Zone): Promise<GmailCalendarAdapter | null> {
  // Check if Google OAuth is configured via auth-keeper
  try {
    const testCommand = `source ${AUTH_KEEPER_PATH} && _ak_google_get_access_token >/dev/null 2>&1 && echo "ok"`;
    const result = await $`bash -c ${testCommand}`.text();
    if (!result.trim().includes("ok")) {
      console.warn("Google OAuth not configured, calendar-gmail adapter not available");
      return null;
    }
  } catch {
    console.warn("Google OAuth not configured, calendar-gmail adapter not available");
    return null;
  }

  return new GmailCalendarAdapter({
    zone,
    source: "calendar-gmail",
    enabled: true,
    credentials: {},
  });
}

// Register adapter
registerAdapter("calendar-gmail", GmailCalendarAdapter as unknown as typeof BaseAdapter);
