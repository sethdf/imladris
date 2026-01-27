/**
 * Triage Module
 *
 * Multi-layer classification system.
 */

export { createTriageEngine, triageWithRules } from "./rules.js";
export type { TriageInput, TriageOutput } from "./rules.js";

export {
  extractEntities,
  extractDates,
  extractPeople,
  extractOrganizations,
  extractUrgencyCues,
  extractTopics,
} from "./entities.js";
export type { ExtractedEntities, ParsedDate, UrgencyCue } from "./entities.js";

export {
  findSimilarItems,
  findSimilarByText,
  suggestClassification,
  suggestClassificationBatch,
  hasSimilarTriagedItems,
  findPotentialDuplicates,
} from "./similarity.js";
export type { SimilarItem, ClassificationSuggestion, SimilaritySearchOptions } from "./similarity.js";
