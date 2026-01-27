/**
 * Triage Module
 *
 * Multi-layer classification system:
 * 1. Entity extraction (chrono-node, compromise)
 * 2. Rules engine (json-rules-engine)
 * 3. Similarity search (Transformers.js)
 * 4. AI verification (Claude) - ALWAYS runs to confirm/override
 */

// Main engine - use this for triage
export { runTriage, triageAndSave, triageBatch } from "./engine.js";
export type { TriageEngineResult, TriageEngineOptions } from "./engine.js";

// AI verifier
export { verifyWithAI, verifyBatchWithAI } from "./ai-verifier.js";
export type { AIVerificationResult, DeterministicContext, VerificationInput } from "./ai-verifier.js";

// Rules engine (layer 2)
export { createTriageEngine, triageWithRules } from "./rules.js";
export type { TriageInput, TriageOutput } from "./rules.js";

// Entity extraction (layer 1)
export {
  extractEntities,
  extractDates,
  extractPeople,
  extractOrganizations,
  extractUrgencyCues,
  extractTopics,
} from "./entities.js";
export type { ExtractedEntities, ParsedDate, UrgencyCue } from "./entities.js";

// Similarity search (layer 3)
export {
  findSimilarItems,
  findSimilarByText,
  suggestClassification,
  suggestClassificationBatch,
  hasSimilarTriagedItems,
  findPotentialDuplicates,
} from "./similarity.js";
export type { SimilarItem, ClassificationSuggestion, SimilaritySearchOptions } from "./similarity.js";
