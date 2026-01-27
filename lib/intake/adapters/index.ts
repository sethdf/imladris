/**
 * Adapters Module
 *
 * Source adapters for syncing data from external sources.
 */

export { BaseAdapter, registerAdapter, getAdapter, listAdapters } from "./base.js";
export type { AdapterConfig, SyncResult } from "./base.js";

// Telegram
export { TelegramAdapter, createTelegramAdapter } from "./telegram.js";

// Signal
export { SignalAdapter, createSignalAdapter } from "./signal.js";

// Email - MS365
export { MS365EmailAdapter, createMS365EmailAdapter } from "./email-ms365.js";

// Email - Gmail
export { GmailAdapter, createGmailAdapter } from "./email-gmail.js";

// Calendar - MS365
export { MS365CalendarAdapter, createMS365CalendarAdapter } from "./calendar-ms365.js";

// Calendar - Gmail
export { GmailCalendarAdapter, createGmailCalendarAdapter } from "./calendar-gmail.js";

// Slack
export { SlackAdapter, createSlackAdapter } from "./slack.js";
