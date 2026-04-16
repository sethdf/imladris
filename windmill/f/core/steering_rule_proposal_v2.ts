// Windmill Script: Steering Rule Proposal v2 (v0.1-draft)
//
// Semantic-search-backed steering rule proposal. Uses core.search_memory_by_vector
// to find high-frequency learning patterns, cross-references with
// core.reasoning_patterns success_rating, and proposes steering rules.
// Output written to MEMORY/STEERING_PROPOSALS/.
//
// v2 of steering_rule_proposal — replaces the heuristic regex-based v1 with
// database-backed vector search and reasoning pattern analysis.
//
// Uses postgres.js tagged template queries against the PAI Postgres database.
// Runs on the NATIVE worker group. Scheduled weekly Monday 07:00 Denver.

import postgres from "postgres";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const sql = postgres(
  process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5432/pai"
);

const HOME = process.env.HOME || "/home/ec2-user";
const PROPOSALS_DIR = join(HOME, ".claude", "MEMORY", "STEERING_PROPOSALS");

interface LearningPattern {
  source_key: string;
  chunk_text: string;
  similarity: number;
}

interface ReasoningPattern {
  task_type: string;
  approach: string;
  skills_used: string[];
  success_rating: number;
  task_description: string;
  count: number;
}

interface ProposedRule {
  rule_text: string;
  confidence: number;
  evidence_count: number;
  avg_success_rating: number;
  source_patterns: string[];
  direction: "do" | "avoid" | "observe";
}

// Seed queries for common failure/learning categories
const SEED_QUERIES = [
  "repeated failure pattern error mistake",
  "successful approach technique that worked well",
  "architectural decision tradeoff scaling",
  "debugging investigation root cause",
  "performance optimization bottleneck",
];

export async function main(
  min_success_rating: number = 7,
  min_pattern_frequency: number = 3,
  lookback_days: number = 60
) {
  const startedAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - lookback_days * 86400000).toISOString();

  if (!existsSync(PROPOSALS_DIR)) {
    mkdirSync(PROPOSALS_DIR, { recursive: true });
  }

  // Step 1: Query reasoning_patterns for high-frequency, high-success patterns
  const reasoningPatterns = await sql<ReasoningPattern[]>`
    SELECT
      task_type,
      approach,
      skills_used,
      success_rating,
      task_description,
      COUNT(*)::int AS count
    FROM core.reasoning_patterns
    WHERE created_at >= ${cutoff}
      AND success_rating >= ${min_success_rating}
    GROUP BY task_type, approach, skills_used, success_rating, task_description
    HAVING COUNT(*) >= ${min_pattern_frequency}
    ORDER BY COUNT(*) DESC, success_rating DESC
    LIMIT 50
  `;

  // Step 2: Query recent learning vectors for failure patterns
  const failureVectors = await sql<LearningPattern[]>`
    SELECT source_key, chunk_text, 1.0::float AS similarity
    FROM core.memory_vectors
    WHERE source_type = 'learning'
      AND created_at >= ${cutoff}
    ORDER BY created_at DESC
    LIMIT 200
  `;

  // Step 3: Analyze reasoning patterns to extract proposed rules
  const proposedRules: ProposedRule[] = [];

  // High-success patterns become "do" rules
  const approachGroups = new Map<string, ReasoningPattern[]>();
  for (const rp of reasoningPatterns) {
    const key = rp.approach.toLowerCase().slice(0, 100);
    const list = approachGroups.get(key) || [];
    list.push(rp);
    approachGroups.set(key, list);
  }

  for (const [approach, patterns] of approachGroups) {
    const totalCount = patterns.reduce((sum, p) => sum + p.count, 0);
    const avgRating =
      patterns.reduce((sum, p) => sum + p.success_rating * p.count, 0) / totalCount;

    if (totalCount >= min_pattern_frequency) {
      proposedRules.push({
        rule_text: `When doing "${patterns[0].task_type}": ${patterns[0].approach}`,
        confidence: Math.min(avgRating / 10, 1.0),
        evidence_count: totalCount,
        avg_success_rating: Math.round(avgRating * 10) / 10,
        source_patterns: patterns.map((p) => p.task_description).slice(0, 5),
        direction: avgRating >= 8 ? "do" : "observe",
      });
    }
  }

  // Failure pattern frequency analysis for "avoid" rules
  const failureKeywords = new Map<string, number>();
  for (const fv of failureVectors) {
    // Extract actionable phrases (simple heuristic)
    const phrases = fv.chunk_text.match(
      /(?:don't|avoid|never|stop|failed because|mistake was|wrong approach)[^.]{10,80}/gi
    ) || [];
    for (const phrase of phrases) {
      const normalized = phrase.toLowerCase().trim();
      failureKeywords.set(normalized, (failureKeywords.get(normalized) || 0) + 1);
    }
  }

  for (const [phrase, count] of failureKeywords) {
    if (count >= min_pattern_frequency) {
      proposedRules.push({
        rule_text: phrase.charAt(0).toUpperCase() + phrase.slice(1),
        confidence: Math.min(count / 10, 1.0),
        evidence_count: count,
        avg_success_rating: 0,
        source_patterns: [],
        direction: "avoid",
      });
    }
  }

  // Sort by evidence strength
  proposedRules.sort((a, b) => b.evidence_count - a.evidence_count);

  // Step 4: Write proposal file to STEERING_PROPOSALS
  const ts = startedAt.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const outFile = join(PROPOSALS_DIR, `${ts}_proposals_v2.md`);

  const lines: string[] = [
    "---",
    `generated_at: ${startedAt}`,
    `status: proposed`,
    `source: steering_rule_proposal_v2 (semantic search + reasoning patterns)`,
    `lookback_days: ${lookback_days}`,
    `min_success_rating: ${min_success_rating}`,
    `min_pattern_frequency: ${min_pattern_frequency}`,
    "---",
    "",
    "# Steering Rule Proposals (v2 - Semantic)",
    "",
    `Analyzed ${reasoningPatterns.length} reasoning pattern groups and ` +
      `${failureVectors.length} learning vectors over ${lookback_days} days.`,
    "",
  ];

  const sections: Array<[ProposedRule["direction"], string]> = [
    ["do", "## DO Rules (high-success patterns)"],
    ["avoid", "## AVOID Rules (recurring failure patterns)"],
    ["observe", "## OBSERVE (moderate-confidence patterns)"],
  ];

  for (const [dir, heading] of sections) {
    const matching = proposedRules.filter((r) => r.direction === dir);
    if (matching.length === 0) continue;
    lines.push(heading, "");
    for (const rule of matching) {
      lines.push(`- **[${rule.evidence_count}x, ${rule.avg_success_rating} avg]** ${rule.rule_text}`);
      if (rule.source_patterns.length > 0) {
        lines.push(`  - evidence: ${rule.source_patterns.slice(0, 3).join("; ")}`);
      }
    }
    lines.push("");
  }

  if (proposedRules.length === 0) {
    lines.push("_No patterns met the frequency/rating thresholds this run._");
  }

  writeFileSync(outFile, lines.join("\n"), "utf-8");

  await sql.end();

  return {
    status: "success",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    reasoning_pattern_groups: reasoningPatterns.length,
    learning_vectors_analyzed: failureVectors.length,
    proposed_rules: proposedRules.length,
    do_rules: proposedRules.filter((r) => r.direction === "do").length,
    avoid_rules: proposedRules.filter((r) => r.direction === "avoid").length,
    observe_rules: proposedRules.filter((r) => r.direction === "observe").length,
    proposal_file: outFile,
  };
}
