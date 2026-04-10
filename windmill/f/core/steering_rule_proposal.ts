// Windmill Script: Steering Rule Proposal
// memory-sync spec Phase 4a
//
// Reads ~/.claude/MEMORY/SYNTHESIS/*.md pattern reports (produced by
// learning_synthesis weekly) and proposes candidate steering rule changes,
// writing them as markdown proposals to ~/.claude/MEMORY/STEERING_PROPOSALS/
// where Seth can review, accept, or reject them.
//
// This is a SIMPLE heuristic pass — look for strong recurring patterns
// (5+ matching signals, consistent sign) and emit a single-line proposal.
// It does NOT call an LLM. A v2 (steering_rule_proposal_v2) is reserved
// for the semantic-search-backed version once Phase 4b is unblocked.
//
// Runs on the NATIVE worker group. Scheduled weekly.

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || "/home/ec2-user";
const SYNTHESIS_DIR = join(HOME, ".claude", "MEMORY", "SYNTHESIS");
const PROPOSALS_DIR = join(HOME, ".claude", "MEMORY", "STEERING_PROPOSALS");

interface PatternHit {
  source_file: string;
  pattern: string;
  signal_count: number;
  direction: "positive" | "negative" | "neutral";
}

function extractPatternHits(md: string, sourceFile: string): PatternHit[] {
  const hits: PatternHit[] = [];
  // Look for lines like:
  //   - [N occurrences] rule text
  //   * Pattern (seen 7 times): description
  //   "Rule: foo — 5+ confirmations"
  const patterns: RegExp[] = [
    /^\s*[-*]\s*\[(\d+)\s*(?:occurrences?|hits?|signals?)\]\s*(.+)$/gim,
    /^\s*[-*]\s*(.+?)\s*\(seen\s+(\d+)\s+times?\)/gim,
    /(\d+)\+?\s+(?:confirmations?|signals?|matches?):\s*(.+)$/gim,
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md)) !== null) {
      const rawCount = m[1].match(/^\d+$/) ? m[1] : m[2];
      const rawText = m[1].match(/^\d+$/) ? m[2] : m[1];
      const count = parseInt(rawCount, 10);
      if (!isNaN(count) && count >= 5 && rawText?.length > 10) {
        const direction: PatternHit["direction"] =
          /correct|success|positive|do\b/i.test(rawText) ? "positive" :
          /fail|wrong|negative|avoid|don't|stop/i.test(rawText) ? "negative" :
          "neutral";
        hits.push({
          source_file: sourceFile,
          pattern: rawText.trim().slice(0, 300),
          signal_count: count,
          direction,
        });
      }
    }
  }
  return hits;
}

function renderProposal(hits: PatternHit[], generatedAt: string): string {
  const lines: string[] = [
    "---",
    `generated_at: ${generatedAt}`,
    `status: proposed`,
    `source: steering_rule_proposal v1 (heuristic — pre-semantic-search)`,
    "---",
    "",
    "# Candidate Steering Rule Proposals",
    "",
    "The weekly synthesis pass found the following recurring patterns with",
    "strong enough signal count (5+) to propose as candidate steering rules.",
    "",
    "Review each one and move accepted rules into `AISTEERINGRULES.md`.",
    "",
  ];

  const byDirection: Record<PatternHit["direction"], PatternHit[]> = {
    positive: [],
    negative: [],
    neutral: [],
  };
  for (const h of hits) byDirection[h.direction].push(h);

  const sections: Array<[PatternHit["direction"], string]> = [
    ["negative", "## Candidate DO-NOT Rules (negative signals)"],
    ["positive", "## Candidate DO Rules (positive signals)"],
    ["neutral", "## Observations (direction unclear)"],
  ];

  for (const [dir, heading] of sections) {
    const list = byDirection[dir];
    if (list.length === 0) continue;
    lines.push(heading, "");
    for (const h of list.sort((a, b) => b.signal_count - a.signal_count)) {
      lines.push(`- **[${h.signal_count} signals]** ${h.pattern}`);
      lines.push(`  - source: \`${h.source_file}\``);
    }
    lines.push("");
  }

  if (hits.length === 0) {
    lines.push("_No candidate rules met the signal-count threshold this run._");
  }

  return lines.join("\n");
}

export async function main(signal_threshold: number = 5) {
  const startedAt = new Date().toISOString();

  if (!existsSync(SYNTHESIS_DIR)) {
    return {
      status: "skipped",
      reason: `SYNTHESIS dir not found: ${SYNTHESIS_DIR}`,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  }

  if (!existsSync(PROPOSALS_DIR)) {
    mkdirSync(PROPOSALS_DIR, { recursive: true });
  }

  // Only look at files modified in the last 8 days (weekly window + 1 day slack)
  const cutoff = Date.now() - 8 * 86400000;
  const allHits: PatternHit[] = [];
  let filesRead = 0;

  for (const f of readdirSync(SYNTHESIS_DIR)) {
    if (!f.endsWith(".md")) continue;
    const fullPath = join(SYNTHESIS_DIR, f);
    const st = statSync(fullPath);
    if (st.mtimeMs < cutoff) continue;
    filesRead++;
    const md = readFileSync(fullPath, "utf-8");
    const hits = extractPatternHits(md, f).filter(h => h.signal_count >= signal_threshold);
    allHits.push(...hits);
  }

  const ts = startedAt.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const outFile = join(PROPOSALS_DIR, `${ts}_proposals.md`);
  const body = renderProposal(allHits, startedAt);
  writeFileSync(outFile, body, "utf-8");

  return {
    status: "success",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    synthesis_files_read: filesRead,
    candidate_rules_found: allHits.length,
    proposal_file: outFile,
    signal_threshold,
  };
}
