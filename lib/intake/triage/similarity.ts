/**
 * Similarity Search for Classification
 *
 * Uses semantic similarity to find related items and infer classification
 * from how similar items were previously triaged.
 */

import {
  getDb,
  queryIntake,
  getTriage,
  type IntakeItem,
  type TriageResult,
  type Zone,
} from "../db/database.js";
import {
  embed,
  cosineSimilarity,
  prepareIntakeText,
  bufferToEmbedding,
} from "../embeddings/pipeline.js";

// =============================================================================
// Types
// =============================================================================

export interface SimilarItem {
  id: string;
  similarity: number;
  subject?: string;
  source: string;
  triage?: TriageResult;
}

export interface ClassificationSuggestion {
  category?: string;
  priority?: string;
  quick_win?: boolean;
  confidence: number;
  reasoning: string;
  similar_items: SimilarItem[];
}

export interface SimilaritySearchOptions {
  zone?: Zone;
  topK?: number;
  minSimilarity?: number;
  requireTriage?: boolean;
  excludeIds?: string[];
}

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SIMILARITY = 0.5;
const STRONG_SIMILARITY_THRESHOLD = 0.8;
const MODERATE_SIMILARITY_THRESHOLD = 0.65;

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Find similar intake items using vector similarity
 */
export async function findSimilarItems(
  item: IntakeItem,
  options: SimilaritySearchOptions = {}
): Promise<SimilarItem[]> {
  const {
    zone,
    topK = DEFAULT_TOP_K,
    minSimilarity = DEFAULT_MIN_SIMILARITY,
    requireTriage = false,
    excludeIds = [],
  } = options;

  // Generate embedding for the query item
  const text = prepareIntakeText(item);
  const queryEmbedding = await embed(text);

  // Get items with embeddings from database
  const candidates = getItemsWithEmbeddings(zone);

  // Calculate similarities
  const results: SimilarItem[] = [];

  for (const candidate of candidates) {
    // Skip excluded items
    if (excludeIds.includes(candidate.id)) continue;
    if (candidate.id === item.id) continue;

    // Skip items without embeddings
    if (!candidate.embedding) continue;

    // Calculate similarity
    const candidateEmbedding = bufferToEmbedding(candidate.embedding as Buffer);
    const similarity = cosineSimilarity(queryEmbedding, candidateEmbedding);

    // Skip low similarity items
    if (similarity < minSimilarity) continue;

    // Get triage info if available
    const triage = getTriage(candidate.id);

    // Skip untriaged items if required
    if (requireTriage && !triage) continue;

    results.push({
      id: candidate.id,
      similarity,
      subject: candidate.subject,
      source: candidate.source,
      triage,
    });
  }

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);

  return results.slice(0, topK);
}

/**
 * Get classification suggestion based on similar items
 */
export async function suggestClassification(
  item: IntakeItem,
  options: SimilaritySearchOptions = {}
): Promise<ClassificationSuggestion | null> {
  // Find similar triaged items
  const similar = await findSimilarItems(item, {
    ...options,
    requireTriage: true,
    topK: options.topK || 10, // Get more for voting
  });

  if (similar.length === 0) {
    return null;
  }

  // Calculate weighted votes for each classification
  const categoryVotes: Record<string, number> = {};
  const priorityVotes: Record<string, number> = {};
  let quickWinVotes = 0;
  let notQuickWinVotes = 0;

  for (const item of similar) {
    if (!item.triage) continue;

    // Weight by similarity score
    const weight = item.similarity;

    if (item.triage.category) {
      categoryVotes[item.triage.category] = (categoryVotes[item.triage.category] || 0) + weight;
    }

    if (item.triage.priority) {
      priorityVotes[item.triage.priority] = (priorityVotes[item.triage.priority] || 0) + weight;
    }

    if (item.triage.quick_win) {
      quickWinVotes += weight;
    } else {
      notQuickWinVotes += weight;
    }
  }

  // Find winning category and priority
  const category = getWinner(categoryVotes);
  const priority = getWinner(priorityVotes);
  const quick_win = quickWinVotes > notQuickWinVotes;

  // Calculate confidence based on similarity and agreement
  const confidence = calculateConfidence(similar, category, priority);

  // Build reasoning
  const reasoning = buildReasoning(similar, category, priority, confidence);

  return {
    category,
    priority,
    quick_win,
    confidence,
    reasoning,
    similar_items: similar.slice(0, 5), // Return top 5 for reference
  };
}

/**
 * Find similar items for a text query (without existing IntakeItem)
 */
export async function findSimilarByText(
  text: string,
  options: SimilaritySearchOptions = {}
): Promise<SimilarItem[]> {
  const pseudoItem: IntakeItem = {
    id: "query",
    zone: options.zone || "work",
    source: "query",
    source_id: "query",
    type: "query",
    body: text,
  };

  return findSimilarItems(pseudoItem, options);
}

// =============================================================================
// Database Helpers
// =============================================================================

/**
 * Get all items with embeddings from database
 */
function getItemsWithEmbeddings(zone?: Zone): IntakeItem[] {
  const db = getDb();

  let sql = "SELECT * FROM intake WHERE embedding IS NOT NULL";
  const params: unknown[] = [];

  if (zone) {
    sql += " AND zone = ?";
    params.push(zone);
  }

  sql += " ORDER BY updated_at DESC LIMIT 1000"; // Cap for performance

  return db.prepare(sql).all(...params) as IntakeItem[];
}

/**
 * Check if an item has similar triaged items
 * Useful for deciding whether to use similarity-based classification
 */
export async function hasSimilarTriagedItems(
  item: IntakeItem,
  minSimilarity = MODERATE_SIMILARITY_THRESHOLD
): Promise<boolean> {
  const similar = await findSimilarItems(item, {
    topK: 1,
    minSimilarity,
    requireTriage: true,
  });

  return similar.length > 0;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the winner from weighted votes
 */
function getWinner(votes: Record<string, number>): string | undefined {
  const entries = Object.entries(votes);
  if (entries.length === 0) return undefined;

  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

/**
 * Calculate confidence score based on similarity and agreement
 */
function calculateConfidence(
  similar: SimilarItem[],
  category?: string,
  priority?: string
): number {
  if (similar.length === 0) return 0;

  // Base confidence from average similarity
  const avgSimilarity = similar.reduce((sum, s) => sum + s.similarity, 0) / similar.length;

  // Boost from strong similarity matches
  const strongMatches = similar.filter((s) => s.similarity >= STRONG_SIMILARITY_THRESHOLD).length;
  const strongBoost = Math.min(strongMatches * 0.1, 0.2);

  // Boost from agreement among similar items
  let agreementBoost = 0;
  const triagedItems = similar.filter((s) => s.triage);

  if (triagedItems.length >= 2) {
    const categoryMatches = triagedItems.filter((s) => s.triage?.category === category).length;
    const priorityMatches = triagedItems.filter((s) => s.triage?.priority === priority).length;

    const categoryAgreement = categoryMatches / triagedItems.length;
    const priorityAgreement = priorityMatches / triagedItems.length;

    agreementBoost = (categoryAgreement + priorityAgreement) / 2 * 0.2;
  }

  // Final confidence, capped at 0.95 (never 100% for similarity-based)
  return Math.min(avgSimilarity + strongBoost + agreementBoost, 0.95);
}

/**
 * Build human-readable reasoning for the suggestion
 */
function buildReasoning(
  similar: SimilarItem[],
  category?: string,
  priority?: string,
  confidence: number
): string {
  const parts: string[] = [];

  // Similarity summary
  const topSimilarity = similar[0]?.similarity || 0;
  if (topSimilarity >= STRONG_SIMILARITY_THRESHOLD) {
    parts.push(`Highly similar to ${similar.length} previous item(s)`);
  } else if (topSimilarity >= MODERATE_SIMILARITY_THRESHOLD) {
    parts.push(`Moderately similar to ${similar.length} previous item(s)`);
  } else {
    parts.push(`Somewhat similar to ${similar.length} previous item(s)`);
  }

  // Classification reasoning
  if (category) {
    const categoryMatches = similar.filter((s) => s.triage?.category === category).length;
    parts.push(`${categoryMatches}/${similar.length} similar items categorized as "${category}"`);
  }

  if (priority) {
    const priorityMatches = similar.filter((s) => s.triage?.priority === priority).length;
    parts.push(`${priorityMatches}/${similar.length} similar items have priority "${priority}"`);
  }

  // Confidence note
  if (confidence >= 0.8) {
    parts.push("High confidence based on strong similarity and agreement");
  } else if (confidence >= 0.6) {
    parts.push("Moderate confidence - recommend review");
  } else {
    parts.push("Low confidence - consider manual triage");
  }

  // Example similar item
  if (similar[0]?.subject) {
    parts.push(`Most similar: "${similar[0].subject}" (${(similar[0].similarity * 100).toFixed(0)}%)`);
  }

  return parts.join(". ") + ".";
}

// =============================================================================
// Batch Operations
// =============================================================================

/**
 * Get classification suggestions for multiple items
 */
export async function suggestClassificationBatch(
  items: IntakeItem[],
  options: SimilaritySearchOptions = {}
): Promise<Map<string, ClassificationSuggestion | null>> {
  const results = new Map<string, ClassificationSuggestion | null>();

  for (const item of items) {
    const suggestion = await suggestClassification(item, options);
    results.set(item.id, suggestion);
  }

  return results;
}

/**
 * Find items that are potentially duplicates
 */
export async function findPotentialDuplicates(
  item: IntakeItem,
  threshold = 0.9
): Promise<SimilarItem[]> {
  return findSimilarItems(item, {
    minSimilarity: threshold,
    topK: 10,
  });
}
