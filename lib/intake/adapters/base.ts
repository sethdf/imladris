/**
 * Base Adapter
 *
 * Abstract base class for all source adapters.
 * Adapters sync data from external sources into the intake system.
 */

import type { IntakeItem, Message, Zone } from "../db/database.js";

// =============================================================================
// Types
// =============================================================================

export interface AdapterConfig {
  zone: Zone;
  source: string;
  enabled: boolean;
  syncInterval?: number; // minutes
  credentials?: Record<string, string>;
}

export interface SyncResult {
  success: boolean;
  itemsProcessed: number;
  itemsCreated: number;
  itemsUpdated: number;
  errors: string[];
  cursor?: string; // For pagination/incremental sync
}

// =============================================================================
// Base Adapter
// =============================================================================

export abstract class BaseAdapter {
  protected config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.config = config;
  }

  /**
   * Get the source identifier
   */
  get source(): string {
    return this.config.source;
  }

  /**
   * Get the zone
   */
  get zone(): Zone {
    return this.config.zone;
  }

  /**
   * Check if adapter is enabled
   */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Validate credentials and connectivity
   */
  abstract validate(): Promise<boolean>;

  /**
   * Sync data from source
   * @param cursor - Optional cursor for incremental sync
   */
  abstract sync(cursor?: string): Promise<SyncResult>;

  /**
   * Transform source data to IntakeItem
   */
  protected abstract transformItem(sourceData: unknown): IntakeItem;

  /**
   * Transform source messages to Message[]
   */
  protected abstract transformMessages(sourceData: unknown): Message[];
}

// =============================================================================
// Adapter Registry
// =============================================================================

const adapters: Map<string, typeof BaseAdapter> = new Map();

export function registerAdapter(source: string, adapter: typeof BaseAdapter): void {
  adapters.set(source, adapter);
}

export function getAdapter(source: string): typeof BaseAdapter | undefined {
  return adapters.get(source);
}

export function listAdapters(): string[] {
  return Array.from(adapters.keys());
}
