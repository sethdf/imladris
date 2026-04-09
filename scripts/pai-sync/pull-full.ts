// pull-full.ts — Full PAI hydration from Postgres
//
// Restores a complete PAI installation from Postgres on a fresh machine:
//   1. memory_objects → ~/.claude/MEMORY/     (learnings, PRDs, failures, wisdom)
//   2. memory_lines → rebuild JSONL files     (ratings, signals, transcripts)
//   3. pai_system → ~/.claude/PAI/            (Algorithm, steering rules, principles)
//   4. pai_system agent_persona → ~/.claude/skills/Agents/
//
// Usage: pai-sync pull --full
// Or:    bun run pull-full.ts

import pg from "pg";
import * as fs from "fs";
import * as path from "path";
import { config } from "./config.ts";

const HOME = process.env.HOME ?? "/home/ec2-user";
const MEMORY_ROOT = `${HOME}/.claude/MEMORY`;
const PAI_ROOT = `${HOME}/.claude/PAI`;
const AGENTS_ROOT = `${HOME}/.claude/skills/Agents`;

// Reverse map: pai_system component_type → filesystem path
const PAI_SYSTEM_MAP: Record<string, string> = {
  algorithm: "Algorithm/v3.5.0.md",
  steering_rules: "AISTEERINGRULES.md",
  founding_principles: "PAISYSTEMARCHITECTURE.md",
  memory_system: "MEMORYSYSTEM.md",
  skill_system: "SKILLSYSTEM.md",
  agent_system: "PAIAGENTSYSTEM.md",
  context_routing: "CONTEXT_ROUTING.md",
  prd_format: "PRDFORMAT.md",
  cli_architecture: "CLI.md",
  cli_architecture_detail: "CLIFIRSTARCHITECTURE.md",
  extendability: "SYSTEM_USER_EXTENDABILITY.md",
};

export async function pullFull() {
  const pool = new pg.Pool({ connectionString: config.postgresUrl, max: 5 });

  const stats = {
    memory_files: 0,
    jsonl_files: 0,
    jsonl_lines: 0,
    pai_system_files: 0,
    agent_personas: 0,
    errors: 0,
  };

  try {
    // 1. Pull all memory_objects → MEMORY/
    console.log("[pull-full] Restoring memory objects...");
    const { rows: objects } = await pool.query(`
      SELECT key, content, compressed FROM core.memory_objects
      WHERE NOT deleted AND content IS NOT NULL
      ORDER BY key
    `);

    for (const obj of objects) {
      try {
        const absPath = path.join(MEMORY_ROOT, ...obj.key.split("/"));
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, obj.content, "utf8");
        stats.memory_files++;
      } catch (e) {
        stats.errors++;
      }
    }
    console.log(`  ${stats.memory_files} memory files restored`);

    // 2. Pull memory_lines → rebuild JSONL files
    console.log("[pull-full] Rebuilding JSONL files...");
    const { rows: lineGroups } = await pool.query(`
      SELECT file_key, array_agg(content ORDER BY created_at) as lines
      FROM core.memory_lines
      GROUP BY file_key
    `);

    for (const group of lineGroups) {
      try {
        const absPath = path.join(MEMORY_ROOT, ...group.file_key.split("/"));
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, group.lines.join("\n") + "\n", "utf8");
        stats.jsonl_files++;
        stats.jsonl_lines += group.lines.length;
      } catch (e) {
        stats.errors++;
      }
    }
    console.log(`  ${stats.jsonl_files} JSONL files rebuilt (${stats.jsonl_lines} lines)`);

    // 3. Pull pai_system methodology → PAI/
    console.log("[pull-full] Restoring PAI methodology...");
    const { rows: methodology } = await pool.query(`
      SELECT key, component_type, content FROM core.pai_system
      WHERE component_type != 'agent_persona' AND content IS NOT NULL
    `);

    for (const m of methodology) {
      const relPath = PAI_SYSTEM_MAP[m.component_type];
      if (!relPath) continue;
      try {
        const absPath = path.join(PAI_ROOT, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, m.content, "utf8");
        stats.pai_system_files++;
      } catch (e) {
        stats.errors++;
      }
    }
    console.log(`  ${stats.pai_system_files} PAI methodology files restored`);

    // 4. Pull agent personas → skills/Agents/
    console.log("[pull-full] Restoring agent personas...");
    const { rows: personas } = await pool.query(`
      SELECT key, content, metadata FROM core.pai_system
      WHERE component_type = 'agent_persona' AND content IS NOT NULL
    `);

    for (const p of personas) {
      try {
        const meta = typeof p.metadata === "string" ? JSON.parse(p.metadata) : p.metadata;
        const filename = meta?.source_file || p.key.split("/").pop() + "Context.md";
        const absPath = path.join(AGENTS_ROOT, filename);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, p.content, "utf8");
        stats.agent_personas++;
      } catch (e) {
        stats.errors++;
      }
    }
    console.log(`  ${stats.agent_personas} agent personas restored`);

    console.log("\n[pull-full] Hydration complete:");
    console.log(`  Memory:     ${stats.memory_files} files`);
    console.log(`  JSONL:      ${stats.jsonl_files} files (${stats.jsonl_lines} lines)`);
    console.log(`  Methodology: ${stats.pai_system_files} files`);
    console.log(`  Personas:   ${stats.agent_personas} files`);
    console.log(`  Errors:     ${stats.errors}`);

    return stats;
  } finally {
    await pool.end();
  }
}

// Run directly
if (import.meta.main) {
  const stats = await pullFull();
  process.exit(stats.errors > 0 ? 1 : 0);
}
