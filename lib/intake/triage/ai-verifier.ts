/**
 * AI Verifier
 *
 * Uses Claude to verify/boost deterministic classification.
 * AI always runs AFTER deterministic tools to confirm or override.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ExtractedEntities, ParsedDate, UrgencyCue } from "./entities.js";
import type { TriageOutput } from "./rules.js";
import type { ClassificationSuggestion, SimilarItem } from "./similarity.js";

// =============================================================================
// Types
// =============================================================================

export interface DeterministicContext {
  entities: ExtractedEntities;
  rulesResult: TriageOutput | null;
  similarityResult: ClassificationSuggestion | null;
}

export interface AIVerificationResult {
  category: string;
  priority: string;
  quick_win: boolean;
  quick_win_reason?: string;
  estimated_time?: string;
  confidence: number;
  reasoning: string;
  action: "confirmed" | "adjusted" | "overridden";
  triaged_by: "ai-verified";
}

export interface VerificationInput {
  id: string;
  zone: string;
  source: string;
  type: string;
  subject?: string;
  body?: string;
  from_name?: string;
  from_address?: string;
  participants?: string;
  created_at?: string;
}

// =============================================================================
// Configuration
// =============================================================================

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 500;

// =============================================================================
// Prompt Building
// =============================================================================

function formatEntities(entities: ExtractedEntities): string {
  const parts: string[] = [];

  if (entities.dates.length > 0) {
    const dateStrs = entities.dates.map((d: ParsedDate) =>
      `${d.text}${d.isDeadline ? " (DEADLINE)" : ""}`
    );
    parts.push(`Dates found: ${dateStrs.join(", ")}`);
  }

  if (entities.people.length > 0) {
    parts.push(`People mentioned: ${entities.people.join(", ")}`);
  }

  if (entities.organizations.length > 0) {
    parts.push(`Organizations: ${entities.organizations.join(", ")}`);
  }

  if (entities.urgency_cues.length > 0) {
    const cueStrs = entities.urgency_cues.map((c: UrgencyCue) =>
      `"${c.text}" (${c.type}, weight: ${c.weight})`
    );
    parts.push(`Urgency cues: ${cueStrs.join(", ")}`);
  }

  if (entities.topics.length > 0) {
    parts.push(`Topics: ${entities.topics.slice(0, 5).join(", ")}`);
  }

  return parts.length > 0 ? parts.join("\n") : "No entities extracted";
}

function formatRulesResult(result: TriageOutput | null): string {
  if (!result) {
    return "No rules matched";
  }

  const parts: string[] = [];
  if (result.category) parts.push(`Category: ${result.category}`);
  if (result.priority) parts.push(`Priority: ${result.priority}`);
  if (result.quick_win) parts.push(`Quick win: ${result.quick_win_reason || "yes"}`);
  if (result.reasoning) parts.push(`Reasoning: ${result.reasoning}`);
  parts.push(`Confidence: ${result.confidence}/10`);

  return parts.join("\n");
}

function formatSimilarityResult(result: ClassificationSuggestion | null): string {
  if (!result) {
    return "No similar items found";
  }

  const parts: string[] = [];
  if (result.category) parts.push(`Suggested category: ${result.category}`);
  if (result.priority) parts.push(`Suggested priority: ${result.priority}`);
  if (result.quick_win !== undefined) parts.push(`Quick win: ${result.quick_win}`);
  parts.push(`Confidence: ${(result.confidence * 100).toFixed(0)}%`);
  parts.push(`Reasoning: ${result.reasoning}`);

  if (result.similar_items.length > 0) {
    parts.push("\nTop similar items:");
    for (const item of result.similar_items.slice(0, 3)) {
      const triageInfo = item.triage
        ? ` → ${item.triage.category}/${item.triage.priority}`
        : " (untriaged)";
      parts.push(`  - "${item.subject}" (${(item.similarity * 100).toFixed(0)}% similar)${triageInfo}`);
    }
  }

  return parts.join("\n");
}

function buildVerificationPrompt(
  item: VerificationInput,
  context: DeterministicContext
): string {
  const proposedCategory = context.rulesResult?.category ||
                           context.similarityResult?.category ||
                           "Unknown";
  const proposedPriority = context.rulesResult?.priority ||
                           context.similarityResult?.priority ||
                           "P2";
  const proposedQuickWin = context.rulesResult?.quick_win ||
                           context.similarityResult?.quick_win ||
                           false;

  // Calculate combined confidence
  const rulesConf = context.rulesResult?.confidence || 0;
  const simConf = context.similarityResult?.confidence || 0;
  const combinedConfidence = Math.max(rulesConf * 10, simConf * 100); // Normalize to 0-100

  return `You are verifying a triage classification for an intake item.

ITEM DETAILS:
- Source: ${item.source} (${item.type})
- Zone: ${item.zone}
- From: ${item.from_name || "unknown"} <${item.from_address || "unknown"}>
- Subject: ${item.subject || "(no subject)"}
- Body preview: ${(item.body || "").substring(0, 500)}${(item.body || "").length > 500 ? "..." : ""}

DETERMINISTIC ANALYSIS:

1. Entity Extraction (chrono-node, compromise):
${formatEntities(context.entities)}

2. Rules Engine (json-rules-engine):
${formatRulesResult(context.rulesResult)}

3. Similarity Search (Transformers.js embeddings):
${formatSimilarityResult(context.similarityResult)}

PROPOSED CLASSIFICATION:
- Category: ${proposedCategory}
- Priority: ${proposedPriority}
- Quick Win: ${proposedQuickWin}
- Combined Confidence: ${combinedConfidence.toFixed(0)}%

CATEGORIES:
- Action-Required: Needs response/action from recipient
- FYI: Informational only, no action needed
- Awaiting-Reply: Waiting on someone else
- Delegated: Handed off to someone
- Scheduled: Has a specific time/date
- Reference: Keep for later reference

PRIORITIES:
- P0: Emergency/Critical (immediate action)
- P1: High (today/urgent)
- P2: Normal (this week)
- P3: Low (when convenient)

TASK: Verify or adjust the proposed classification.

Respond with ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "action": "confirmed" | "adjusted" | "overridden",
  "category": "Action-Required" | "FYI" | "Awaiting-Reply" | "Delegated" | "Scheduled" | "Reference",
  "priority": "P0" | "P1" | "P2" | "P3",
  "quick_win": true | false,
  "quick_win_reason": "string if quick_win is true, otherwise null",
  "estimated_time": "5min" | "15min" | "30min" | "1hr" | "2hr+" | null,
  "confidence": 85-100,
  "reasoning": "Brief explanation of verification decision"
}`;
}

// =============================================================================
// AI Verification
// =============================================================================

export async function verifyWithAI(
  item: VerificationInput,
  context: DeterministicContext
): Promise<AIVerificationResult> {
  const client = new Anthropic();
  const prompt = buildVerificationPrompt(item, context);

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    // Extract text content
    const textContent = response.content.find((c) => c.type === "text");
    if (!textContent || textContent.type !== "text") {
      throw new Error("No text response from AI");
    }

    // Parse JSON response
    const result = JSON.parse(textContent.text) as {
      action: "confirmed" | "adjusted" | "overridden";
      category: string;
      priority: string;
      quick_win: boolean;
      quick_win_reason?: string;
      estimated_time?: string;
      confidence: number;
      reasoning: string;
    };

    return {
      category: result.category,
      priority: result.priority,
      quick_win: result.quick_win,
      quick_win_reason: result.quick_win_reason,
      estimated_time: result.estimated_time,
      confidence: result.confidence,
      reasoning: result.reasoning,
      action: result.action,
      triaged_by: "ai-verified",
    };
  } catch (err) {
    // Fallback to deterministic result if AI fails
    console.error("AI verification failed, using deterministic result:", err);

    return {
      category: context.rulesResult?.category ||
                context.similarityResult?.category ||
                "Action-Required",
      priority: context.rulesResult?.priority ||
                context.similarityResult?.priority ||
                "P2",
      quick_win: context.rulesResult?.quick_win ||
                 context.similarityResult?.quick_win ||
                 false,
      quick_win_reason: context.rulesResult?.quick_win_reason,
      estimated_time: context.rulesResult?.estimated_time,
      confidence: Math.max(
        (context.rulesResult?.confidence || 0) * 10,
        (context.similarityResult?.confidence || 0) * 100
      ),
      reasoning: "AI verification failed, using deterministic classification",
      action: "confirmed",
      triaged_by: "ai-verified",
    };
  }
}

// =============================================================================
// Batch Verification
// =============================================================================

export async function verifyBatchWithAI(
  items: Array<{ item: VerificationInput; context: DeterministicContext }>
): Promise<Map<string, AIVerificationResult>> {
  const results = new Map<string, AIVerificationResult>();

  // Process sequentially to avoid rate limits
  for (const { item, context } of items) {
    const result = await verifyWithAI(item, context);
    results.set(item.id, result);
  }

  return results;
}
