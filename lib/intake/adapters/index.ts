/**
 * Adapters Module
 *
 * Source adapters for syncing data from external sources.
 */

export { BaseAdapter, registerAdapter, getAdapter, listAdapters } from "./base.js";
export type { AdapterConfig, SyncResult } from "./base.js";

// Import and register adapters here
// import { TelegramAdapter } from "./telegram.js";
// import { SlackAdapter } from "./slack.js";
// registerAdapter("telegram", TelegramAdapter);
// registerAdapter("slack", SlackAdapter);
