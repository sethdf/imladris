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
