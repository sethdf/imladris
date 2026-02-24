#!/usr/bin/env bun
// index-learnings.ts — Learning Index Builder
// Phase 6 Gap: Better indexing of reflections by problem domain
//
// Reads algorithm-reflections.jsonl, extracts domain tags,
// writes searchable index for CONTEXT RECOVERY.
//
// Usage: bun run scripts/index-learnings.ts

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const REFLECTIONS_PATH = join(HOME, ".claude", "MEMORY", "LEARNING", "REFLECTIONS", "algorithm-reflections.jsonl");
const INDEX_PATH = join(HOME, ".claude", "MEMORY", "LEARNING", "REFLECTIONS", "learning-index.json");

// Domain keywords for auto-tagging
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  iam: ["iam", "role", "policy", "permission", "assume", "credential", "auth", "access"],
  networking: ["vpc", "subnet", "security group", "route", "cidr", "dns", "endpoint", "eni"],
  dns: ["route53", "dns", "cname", "alias", "hosted zone", "record", "domain"],
  cost: ["cost", "budget", "savings", "spend", "billing", "pricing", "reserved"],
  security: ["security", "vulnerability", "cve", "patch", "encryption", "key", "kms", "firewall"],
  compute: ["ec2", "instance", "lambda", "container", "ecs", "fargate", "ami"],
  storage: ["s3", "ebs", "volume", "snapshot", "backup", "glacier"],
  database: ["rds", "dynamodb", "database", "postgres", "mysql", "redis"],
  monitoring: ["cloudwatch", "alarm", "metric", "log", "trace", "monitor"],
  deployment: ["deploy", "cloudformation", "stack", "ansible", "terraform", "pipeline", "ci/cd"],
  windmill: ["windmill", "script", "flow", "schedule", "webhook"],
  sdp: ["ticket", "sdp", "servicedesk", "helpdesk", "incident"],
  docker: ["docker", "container", "compose", "image"],
  tailscale: ["tailscale", "vpn", "mesh", "wireguard"],
};

interface Reflection {
  timestamp: string;
  effort_level: string;
  task_description: string;
  criteria_count: number;
  criteria_passed: number;
  criteria_failed: number;
  prd_id?: string;
  reflection_q1?: string;
  reflection_q2?: string;
  reflection_q3?: string;
  within_budget?: boolean;
}

interface IndexEntry {
  timestamp: string;
  task_description: string;
  domains: string[];
  prd_id?: string;
  effort_level: string;
  success_rate: number;
  key_insight?: string;
}

function extractDomains(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.push(domain);
        break;
      }
    }
  }

  return matched.length > 0 ? matched : ["general"];
}

function extractKeyInsight(reflection: Reflection): string {
  // Pull the most actionable sentence from reflections
  for (const q of [reflection.reflection_q1, reflection.reflection_q2, reflection.reflection_q3]) {
    if (q && q.length > 10 && q.length < 200) return q;
  }
  return "";
}

function main(): void {
  if (!existsSync(REFLECTIONS_PATH)) {
    console.log("No reflections file found at:", REFLECTIONS_PATH);
    console.log("Reflections are written during Algorithm LEARN phase.");
    return;
  }

  const lines = readFileSync(REFLECTIONS_PATH, "utf-8").trim().split("\n").filter(Boolean);
  const index: IndexEntry[] = [];

  for (const line of lines) {
    try {
      const r: Reflection = JSON.parse(line);
      const allText = [
        r.task_description,
        r.reflection_q1,
        r.reflection_q2,
        r.reflection_q3,
      ].filter(Boolean).join(" ");

      const total = r.criteria_count || 1;
      const passed = r.criteria_passed || 0;

      index.push({
        timestamp: r.timestamp,
        task_description: r.task_description,
        domains: extractDomains(allText),
        prd_id: r.prd_id,
        effort_level: r.effort_level,
        success_rate: Math.round((passed / total) * 100),
        key_insight: extractKeyInsight(r),
      });
    } catch {
      // Skip malformed entries
    }
  }

  // Build domain summary
  const domainSummary: Record<string, { count: number; avg_success: number; recent: string[] }> = {};
  for (const entry of index) {
    for (const domain of entry.domains) {
      if (!domainSummary[domain]) {
        domainSummary[domain] = { count: 0, avg_success: 0, recent: [] };
      }
      domainSummary[domain].count++;
      domainSummary[domain].avg_success += entry.success_rate;
      if (domainSummary[domain].recent.length < 3) {
        domainSummary[domain].recent.push(entry.task_description);
      }
    }
  }
  for (const d of Object.values(domainSummary)) {
    d.avg_success = Math.round(d.avg_success / d.count);
  }

  const output = {
    last_indexed: new Date().toISOString(),
    total_reflections: index.length,
    domains: domainSummary,
    entries: index,
  };

  const dir = join(HOME, ".claude", "MEMORY", "LEARNING", "REFLECTIONS");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(INDEX_PATH, JSON.stringify(output, null, 2));
  console.log(`Indexed ${index.length} reflections across ${Object.keys(domainSummary).length} domains`);
  console.log(`Written to: ${INDEX_PATH}`);
}

main();
