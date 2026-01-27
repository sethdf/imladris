/**
 * Triage Engine
 *
 * Unified triage pipeline that runs all layers:
 * 1. Entity extraction (chrono-node, compromise)
 * 2. Rules engine (json-rules-engine)
 * 3. Similarity search (Transformers.js)
 * 4. AI verification (Claude) - ALWAYS runs to confirm/override
 */

import type { IntakeItem } from "../db/database.js";
import { upsertTriage } from "../db/database.js";
import { extractEntities, type ExtractedEntities } from "./entities.js";
import { triageWithRules, type TriageOutput } from "./rules.js";
import { suggestClassification, type ClassificationSuggestion } from "./similarity.js";
import { verifyWithAI, type AIVerificationResult, type DeterministicContext } from "./ai-verifier.js";

// =============================================================================
// Types
// =============================================================================

export interface TriageEngineResult {
  id: string;
  category: string;
  priority: string;
  quick_win: boolean;
  quick_win_reason?: string;
  estimated_time?: string;
  confidence: number;
  reasoning: string;
  triaged_by: "ai-verified";

  // Layer details for transparency
  layers: {
    entities: ExtractedEntities;
    rules: TriageOutput | null;
    similarity: ClassificationSuggestion | null;
    ai: AIVerificationResult;
  };
}

export interface TriageEngineOptions {
  skipAI?: boolean; // For testing deterministic layers only
  verbose?: boolean; // Log layer results
}

// =============================================================================
// Main Engine
// =============================================================================

/**
 * Run full triage pipeline on an intake item
 */
export async function runTriage(
  item: IntakeItem,
  options: TriageEngineOptions = {}
): Promise<TriageEngineResult> {
  const { skipAI = false, verbose = false } = options;

  if (verbose) {
    console.log(`\nTriaging: ${item.subject || item.id}`);
    console.log("─".repeat(60));
  }

  // Layer 1: Entity extraction
  const text = `${item.subject || ""} ${item.body || ""}`;
  const entities = extractEntities(text);

  if (verbose) {
    console.log("\n1. Entity Extraction:");
    console.log(`   Dates: ${entities.dates.length}`);
    console.log(`   People: ${entities.people.join(", ") || "none"}`);
    console.log(`   Orgs: ${entities.organizations.join(", ") || "none"}`);
    console.log(`   Urgency cues: ${entities.urgency_cues.length}`);
  }

  // Layer 2: Rules engine
  const rulesInput = {
    id: item.id,
    zone: item.zone,
    source: item.source,
    type: item.type,
    subject: item.subject,
    body: item.body,
    from_name: item.from_name,
    from_address: item.from_address,
    participants: item.participants?.split(", "),
    created_at: item.created_at ? new Date(item.created_at) : undefined,
    entities: {
      dates: entities.dates.map((d) => d.text),
      times: [],
      people: entities.people,
      organizations: entities.organizations,
      urgency_cues: entities.urgency_cues.map((c) => c.text),
    },
  };

  const rulesResult = await triageWithRules(rulesInput);

  if (verbose) {
    console.log("\n2. Rules Engine:");
    if (rulesResult) {
      console.log(`   Category: ${rulesResult.category || "none"}`);
      console.log(`   Priority: ${rulesResult.priority || "none"}`);
      console.log(`   Confidence: ${rulesResult.confidence}/10`);
      console.log(`   Reasoning: ${rulesResult.reasoning || "none"}`);
    } else {
      console.log("   No rules matched");
    }
  }

  // Layer 3: Similarity search
  let similarityResult: ClassificationSuggestion | null = null;
  try {
    similarityResult = await suggestClassification(item, {
      zone: item.zone as "work" | "home",
      topK: 5,
      minSimilarity: 0.5,
    });
  } catch (err) {
    if (verbose) {
      console.log("\n3. Similarity Search: Error -", err);
    }
  }

  if (verbose) {
    console.log("\n3. Similarity Search:");
    if (similarityResult) {
      console.log(`   Suggested: ${similarityResult.category}/${similarityResult.priority}`);
      console.log(`   Confidence: ${(similarityResult.confidence * 100).toFixed(0)}%`);
      console.log(`   Similar items: ${similarityResult.similar_items.length}`);
    } else {
      console.log("   No similar items found");
    }
  }

  // Layer 4: AI verification (always runs unless skipped)
  const deterministicContext: DeterministicContext = {
    entities,
    rulesResult,
    similarityResult,
  };

  let aiResult: AIVerificationResult;

  if (skipAI) {
    // Use deterministic result without AI
    aiResult = {
      category: rulesResult?.category || similarityResult?.category || "Action-Required",
      priority: rulesResult?.priority || similarityResult?.priority || "P2",
      quick_win: rulesResult?.quick_win || similarityResult?.quick_win || false,
      quick_win_reason: rulesResult?.quick_win_reason,
      estimated_time: rulesResult?.estimated_time,
      confidence: Math.max(
        (rulesResult?.confidence || 0) * 10,
        (similarityResult?.confidence || 0) * 100
      ),
      reasoning: "AI verification skipped",
      action: "confirmed",
      triaged_by: "ai-verified",
    };

    if (verbose) {
      console.log("\n4. AI Verification: SKIPPED");
    }
  } else {
    const verificationInput = {
      id: item.id,
      zone: item.zone,
      source: item.source,
      type: item.type,
      subject: item.subject,
      body: item.body,
      from_name: item.from_name,
      from_address: item.from_address,
      participants: item.participants,
      created_at: item.created_at,
    };

    aiResult = await verifyWithAI(verificationInput, deterministicContext);

    if (verbose) {
      console.log("\n4. AI Verification:");
      console.log(`   Action: ${aiResult.action}`);
      console.log(`   Category: ${aiResult.category}`);
      console.log(`   Priority: ${aiResult.priority}`);
      console.log(`   Confidence: ${aiResult.confidence}%`);
      console.log(`   Reasoning: ${aiResult.reasoning}`);
    }
  }

  // Build final result
  const result: TriageEngineResult = {
    id: item.id,
    category: aiResult.category,
    priority: aiResult.priority,
    quick_win: aiResult.quick_win,
    quick_win_reason: aiResult.quick_win_reason,
    estimated_time: aiResult.estimated_time,
    confidence: aiResult.confidence,
    reasoning: aiResult.reasoning,
    triaged_by: "ai-verified",
    layers: {
      entities,
      rules: rulesResult,
      similarity: similarityResult,
      ai: aiResult,
    },
  };

  if (verbose) {
    console.log("\n" + "─".repeat(60));
    console.log(`FINAL: ${result.category}/${result.priority} (${result.confidence}% confidence)`);
    console.log(`Quick win: ${result.quick_win ? `Yes - ${result.quick_win_reason}` : "No"}`);
  }

  return result;
}

/**
 * Run triage and persist result to database
 */
export async function triageAndSave(
  item: IntakeItem,
  options: TriageEngineOptions = {}
): Promise<TriageEngineResult> {
  const result = await runTriage(item, options);

  // Save to database
  upsertTriage({
    intake_id: item.id,
    category: result.category,
    priority: result.priority,
    quick_win: result.quick_win,
    quick_win_reason: result.quick_win_reason,
    estimated_time: result.estimated_time,
    confidence: result.confidence,
    triaged_by: result.triaged_by,
    reasoning: result.reasoning,
  });

  return result;
}

/**
 * Run triage on multiple items
 */
export async function triageBatch(
  items: IntakeItem[],
  options: TriageEngineOptions = {}
): Promise<Map<string, TriageEngineResult>> {
  const results = new Map<string, TriageEngineResult>();

  for (const item of items) {
    const result = await triageAndSave(item, options);
    results.set(item.id, result);
  }

  return results;
}
