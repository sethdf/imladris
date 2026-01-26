/**
 * Entity Extraction
 *
 * Extract dates, times, people, organizations from text.
 * Uses chrono-node for dates and compromise for NER.
 */

import * as chrono from "chrono-node";
import nlp from "compromise";

// =============================================================================
// Types
// =============================================================================

export interface ExtractedEntities {
  dates: ParsedDate[];
  people: string[];
  organizations: string[];
  urgency_cues: UrgencyCue[];
  topics: string[];
}

export interface ParsedDate {
  text: string;
  date: Date;
  isDeadline: boolean;
}

export interface UrgencyCue {
  text: string;
  type: "explicit" | "implied" | "deadline";
  weight: number;
}

// =============================================================================
// Date Extraction
// =============================================================================

export function extractDates(text: string, referenceDate?: Date): ParsedDate[] {
  const ref = referenceDate || new Date();
  const results = chrono.parse(text, ref);

  return results.map((result) => {
    // Check if this looks like a deadline
    const contextStart = Math.max(0, result.index - 30);
    const contextEnd = Math.min(text.length, result.index + result.text.length + 30);
    const context = text.substring(contextStart, contextEnd).toLowerCase();

    const deadlineKeywords = ["deadline", "due", "by", "before", "until", "no later than"];
    const isDeadline = deadlineKeywords.some((k) => context.includes(k));

    return {
      text: result.text,
      date: result.start.date(),
      isDeadline,
    };
  });
}

// =============================================================================
// NLP Entity Extraction
// =============================================================================

export function extractPeople(text: string): string[] {
  const doc = nlp(text);
  const people = doc.people().out("array") as string[];

  // Deduplicate and clean
  const unique = new Set<string>();
  for (const person of people) {
    const cleaned = person.trim();
    if (cleaned.length > 1) {
      unique.add(cleaned);
    }
  }

  return Array.from(unique);
}

export function extractOrganizations(text: string): string[] {
  const doc = nlp(text);
  const orgs = doc.organizations().out("array") as string[];

  // Deduplicate and clean
  const unique = new Set<string>();
  for (const org of orgs) {
    const cleaned = org.trim();
    if (cleaned.length > 1) {
      unique.add(cleaned);
    }
  }

  return Array.from(unique);
}

export function extractTopics(text: string): string[] {
  const doc = nlp(text);

  // Extract nouns and noun phrases as potential topics
  const nouns = doc.nouns().out("array") as string[];
  const topics = doc.topics().out("array") as string[];

  // Combine and deduplicate
  const unique = new Set<string>();
  for (const item of [...nouns, ...topics]) {
    const cleaned = item.trim().toLowerCase();
    if (cleaned.length > 2 && !isStopWord(cleaned)) {
      unique.add(cleaned);
    }
  }

  return Array.from(unique).slice(0, 10); // Limit to top 10
}

// =============================================================================
// Urgency Detection
// =============================================================================

const URGENCY_PATTERNS: Array<{ pattern: RegExp; type: UrgencyCue["type"]; weight: number }> = [
  // Explicit urgency
  { pattern: /\burgent\b/i, type: "explicit", weight: 10 },
  { pattern: /\basap\b/i, type: "explicit", weight: 9 },
  { pattern: /\bimmediately\b/i, type: "explicit", weight: 9 },
  { pattern: /\bemergency\b/i, type: "explicit", weight: 10 },
  { pattern: /\bcritical\b/i, type: "explicit", weight: 8 },
  { pattern: /\bhigh priority\b/i, type: "explicit", weight: 8 },

  // Implied urgency
  { pattern: /\btoday\b/i, type: "implied", weight: 6 },
  { pattern: /\beod\b/i, type: "implied", weight: 7 },
  { pattern: /\bend of day\b/i, type: "implied", weight: 7 },
  { pattern: /\bthis morning\b/i, type: "implied", weight: 6 },
  { pattern: /\bthis afternoon\b/i, type: "implied", weight: 5 },
  { pattern: /\bright away\b/i, type: "implied", weight: 7 },
  { pattern: /\btime.?sensitive\b/i, type: "implied", weight: 8 },

  // Deadline indicators
  { pattern: /\bdeadline\b/i, type: "deadline", weight: 7 },
  { pattern: /\bdue\s+(by|date)\b/i, type: "deadline", weight: 6 },
  { pattern: /\bexpir(es?|ing)\b/i, type: "deadline", weight: 6 },
];

export function extractUrgencyCues(text: string): UrgencyCue[] {
  const cues: UrgencyCue[] = [];

  for (const { pattern, type, weight } of URGENCY_PATTERNS) {
    const matches = text.match(new RegExp(pattern, "gi"));
    if (matches) {
      for (const match of matches) {
        cues.push({ text: match, type, weight });
      }
    }
  }

  // Sort by weight descending
  cues.sort((a, b) => b.weight - a.weight);

  return cues;
}

// =============================================================================
// Combined Extraction
// =============================================================================

export function extractEntities(text: string, referenceDate?: Date): ExtractedEntities {
  return {
    dates: extractDates(text, referenceDate),
    people: extractPeople(text),
    organizations: extractOrganizations(text),
    urgency_cues: extractUrgencyCues(text),
    topics: extractTopics(text),
  };
}

// =============================================================================
// Utilities
// =============================================================================

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "was",
  "are",
  "were",
  "been",
  "be",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "what",
  "which",
  "who",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "not",
  "only",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "also",
  "now",
  "here",
  "there",
  "then",
]);

function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word.toLowerCase());
}
