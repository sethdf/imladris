/**
 * Base Adapter
 *
 * Abstract base class for all source adapters.
 * Adapters sync data from external sources into the intake system.
 */

import { upsertIntake, queryIntake, type IntakeItem, type Message, type Zone } from "../db/database.js";
import { triageAndSave, isServiceAvailable } from "../triage/client.js";
import { triageAndSave as triageAndSaveLegacy } from "../triage/engine.js";

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
// Triage Helper
// =============================================================================

/**
 * Upsert an intake item and run triage on it
 *
 * This should be called for the FINAL upsert of an item (after context is built).
 * Triage runs async and doesn't block the sync process on failure.
 */
export async function upsertAndTriage(
  item: Partial<IntakeItem> & { source: string; source_id: string; type: string },
  options: { verbose?: boolean } = {}
): Promise<string> {
  // Upsert the item first
  const intakeId = upsertIntake(item);

  // Get the full item for triage (query by source+source_id)
  const items = queryIntake({ source: [item.source], limit: 100 });
  const fullItem = items.find((i) => i.source_id === item.source_id);

  if (!fullItem) {
    return intakeId;
  }

  // Run triage async - don't block sync on triage failures
  try {
    const serviceAvailable = await isServiceAvailable();

    if (serviceAvailable) {
      await triageAndSave(fullItem, { verbose: options.verbose });
    } else {
      await triageAndSaveLegacy(fullItem, { verbose: options.verbose });
    }
  } catch (err) {
    if (options.verbose) {
      console.warn(`Triage failed for ${intakeId}: ${err}`);
    }
    // Don't throw - triage failure shouldn't fail the sync
  }

  return intakeId;
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
