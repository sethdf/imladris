/**
 * Triage Module
 *
 * Production multi-layer classification system:
 * 1. Entity extraction (spaCy via Python service)
 * 2. Similarity search (ChromaDB via Python service)
 * 3. Rules engine (Python service)
 * 4. AI verification (Instructor + Claude via Python service)
 *
 * The Python triage-service must be running for full functionality.
 * Falls back to legacy TypeScript implementation if service unavailable.
 */

// =============================================================================
// Production Client (Python service) - PREFERRED
// =============================================================================

export {
  checkHealth,
  isServiceAvailable,
  triage,
  triageAndSave,
  extractEntities as extractEntitiesRemote,
  findSimilar,
  recordCorrection,
  storeItem,
} from "./client.js";

export type {
  TriageResult,
  ExtractedEntities as RemoteExtractedEntities,
  SimilarItem as RemoteSimilarItem,
  HealthResponse,
  CorrectionRequest,
} from "./client.js";

// =============================================================================
// Legacy TypeScript Implementation (fallback)
// =============================================================================

// Main engine - use this for triage
export { runTriage, triageAndSave as triageAndSaveLegacy, triageBatch } from "./engine.js";
export type { TriageEngineResult, TriageEngineOptions } from "./engine.js";

// AI verifier
export { verifyWithAI, verifyBatchWithAI } from "./ai-verifier.js";
export type { AIVerificationResult, DeterministicContext, VerificationInput } from "./ai-verifier.js";

// Rules engine (layer 2)
export { createTriageEngine, triageWithRules } from "./rules.js";
export type { TriageInput, TriageOutput } from "./rules.js";

// Entity extraction (layer 1) - legacy
export {
  extractEntities,
  extractDates,
  extractPeople,
  extractOrganizations,
  extractUrgencyCues,
  extractTopics,
} from "./entities.js";
export type { ExtractedEntities, ParsedDate, UrgencyCue } from "./entities.js";

// Similarity search (layer 3) - legacy
export {
  findSimilarItems,
  findSimilarByText,
  suggestClassification,
  suggestClassificationBatch,
  hasSimilarTriagedItems,
  findPotentialDuplicates,
} from "./similarity.js";
export type { SimilarItem, ClassificationSuggestion, SimilaritySearchOptions } from "./similarity.js";
