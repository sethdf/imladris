/**
 * Triage Service Client
 *
 * TypeScript client for the Python triage service.
 * Calls the FastAPI service for entity extraction, similarity, and AI classification.
 */

import type { IntakeItem } from "../db/database.js";

// =============================================================================
// Configuration
// =============================================================================

const SERVICE_URL = process.env.TRIAGE_SERVICE_URL || "http://127.0.0.1:8100";

// =============================================================================
// Types (mirror Python models)
// =============================================================================

export interface ExtractedEntity {
  text: string;
  label: string;
  start: number;
  end: number;
}

export interface ExtractedEntities {
  people: string[];
  organizations: string[];
  dates: string[];
  times: string[];
  locations: string[];
  urgency_cues: string[];
  all_entities: ExtractedEntity[];
}

export interface SimilarItem {
  id: string;
  similarity: number;
  subject?: string;
  category?: string;
  priority?: string;
}

export interface TriageResult {
  id: string;
  category: string;
  priority: string;
  quick_win: boolean;
  quick_win_reason?: string;
  estimated_time?: string;
  confidence: number;
  reasoning: string;
  action: string;
  triaged_by: string;
  entities: ExtractedEntities;
  similar_items: SimilarItem[];
  rule_matches: string[];
}

export interface HealthResponse {
  status: string;
  spacy_model: string;
  chroma_collections: number;
  version: string;
}

export interface CorrectionRequest {
  intake_id: string;
  original_category?: string;
  original_priority?: string;
  corrected_category: string;
  corrected_priority: string;
  reason?: string;
}

// =============================================================================
// Client Functions
// =============================================================================

/**
 * Check if triage service is healthy
 */
export async function checkHealth(): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`${SERVICE_URL}/health`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Check if triage service is available
 */
export async function isServiceAvailable(): Promise<boolean> {
  const health = await checkHealth();
  return health?.status === "healthy";
}

/**
 * Extract entities from text
 */
export async function extractEntities(text: string): Promise<ExtractedEntities> {
  const response = await fetch(`${SERVICE_URL}/entities?text=${encodeURIComponent(text)}`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Entity extraction failed: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Find similar items
 */
export async function findSimilar(
  item: IntakeItem,
  topK: number = 5,
  zone?: string
): Promise<SimilarItem[]> {
  const params = new URLSearchParams();
  params.set("top_k", String(topK));
  if (zone) params.set("zone", zone);

  const response = await fetch(`${SERVICE_URL}/similar?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });

  if (!response.ok) {
    throw new Error(`Similarity search failed: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Run full triage pipeline on an item
 */
export async function triage(item: IntakeItem, skipAI: boolean = false): Promise<TriageResult> {
  const params = new URLSearchParams();
  if (skipAI) params.set("skip_ai", "true");

  const response = await fetch(`${SERVICE_URL}/triage?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Triage failed: ${response.statusText} - ${error}`);
  }

  return await response.json();
}

/**
 * Record a user correction
 */
export async function recordCorrection(correction: CorrectionRequest): Promise<void> {
  const response = await fetch(`${SERVICE_URL}/correct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(correction),
  });

  if (!response.ok) {
    throw new Error(`Recording correction failed: ${response.statusText}`);
  }
}

/**
 * Store an item in ChromaDB
 */
export async function storeItem(
  item: IntakeItem,
  category?: string,
  priority?: string
): Promise<void> {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (priority) params.set("priority", priority);

  const response = await fetch(`${SERVICE_URL}/store?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });

  if (!response.ok) {
    throw new Error(`Storing item failed: ${response.statusText}`);
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Triage an intake item and save to database
 *
 * This is the main function adapters should call after upsertIntake()
 */
export async function triageAndSave(
  item: IntakeItem,
  options: { skipAI?: boolean; verbose?: boolean } = {}
): Promise<TriageResult | null> {
  const { skipAI = false, verbose = false } = options;

  // Check if service is available
  const available = await isServiceAvailable();
  if (!available) {
    if (verbose) {
      console.log("Triage service not available, skipping triage");
    }
    return null;
  }

  try {
    const result = await triage(item, skipAI);

    if (verbose) {
      console.log(`Triaged: ${item.subject || item.id}`);
      console.log(`  → ${result.category}/${result.priority} (${result.confidence}%)`);
      console.log(`  → Action: ${result.action}`);
      if (result.quick_win) {
        console.log(`  → Quick win: ${result.quick_win_reason}`);
      }
    }

    return result;
  } catch (err) {
    if (verbose) {
      console.error(`Triage failed for ${item.id}:`, err);
    }
    return null;
  }
}
