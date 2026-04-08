// ============================================================
// pai-system-sync.ts — Sync PAI methodology files to pai_system table
//
// Watches ~/.claude/PAI/ and ~/.claude/skills/Agents/ and syncs
// methodology content to core.pai_system so Palantír can serve it
// via assemble_context().
//
// Component types in pai_system:
//   algorithm, steering_rules, founding_principles, system_architecture,
//   memory_system, skill_system, agent_system, context_routing,
//   prd_format, telos, agent_persona, cli_architecture
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import pg from "pg";
import { config } from "./config.ts";

// Map PAI files to their component types
const PAI_FILE_MAP: Record<string, string> = {
  "Algorithm/v3.5.0.md": "algorithm",
  "AISTEERINGRULES.md": "steering_rules",
  "PAISYSTEMARCHITECTURE.md": "founding_principles",
  "MEMORYSYSTEM.md": "memory_system",
  "SKILLSYSTEM.md": "skill_system",
  "PAIAGENTSYSTEM.md": "agent_system",
  "CONTEXT_ROUTING.md": "context_routing",
  "PRDFORMAT.md": "prd_format",
  "CLI.md": "cli_architecture",
  "CLIFIRSTARCHITECTURE.md": "cli_architecture_detail",
  "SYSTEM_USER_EXTENDABILITY.md": "extendability",
};

// Dynamically detect Algorithm version
function findAlgorithmFile(paiRoot: string): string | null {
  const algoDir = path.join(paiRoot, "Algorithm");
  if (!fs.existsSync(algoDir)) return null;
  const latestFile = path.join(algoDir, "LATEST");
  if (fs.existsSync(latestFile)) {
    const version = fs.readFileSync(latestFile, "utf8").trim();
    const vFile = path.join(algoDir, `v${version}.md`);
    if (fs.existsSync(vFile)) return vFile;
  }
  // Fallback: find any v*.md
  const files = fs.readdirSync(algoDir).filter(f => f.startsWith("v") && f.endsWith(".md"));
  if (files.length > 0) return path.join(algoDir, files.sort().pop()!);
  return null;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function syncPaiSystem(pool: pg.Pool): Promise<{
  synced: number;
  skipped: number;
  errors: number;
  components: string[];
}> {
  let synced = 0, skipped = 0, errors = 0;
  const components: string[] = [];

  // 1. Sync PAI methodology files
  for (const [relPath, componentType] of Object.entries(PAI_FILE_MAP)) {
    let absPath: string;
    if (relPath.startsWith("Algorithm/")) {
      const algoFile = findAlgorithmFile(config.paiRoot);
      if (!algoFile) { skipped++; continue; }
      absPath = algoFile;
    } else {
      absPath = path.join(config.paiRoot, relPath);
    }

    if (!fs.existsSync(absPath)) { skipped++; continue; }

    try {
      const content = fs.readFileSync(absPath, "utf8");
      const contentHash = sha256(content);
      const key = `pai/${componentType}`;

      // Check if already up to date
      const { rows } = await pool.query(
        `SELECT content_hash FROM core.pai_system WHERE key = $1`,
        [key]
      );

      if (rows.length > 0 && rows[0].content_hash === contentHash) {
        skipped++;
        continue;
      }

      await pool.query(`
        INSERT INTO core.pai_system (key, component_type, content, metadata, content_hash, version, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 1, NOW(), NOW())
        ON CONFLICT (key) DO UPDATE SET
          content = EXCLUDED.content,
          metadata = EXCLUDED.metadata,
          content_hash = EXCLUDED.content_hash,
          version = core.pai_system.version + 1,
          updated_at = NOW()
      `, [
        key,
        componentType,
        content,
        JSON.stringify({ source_file: relPath, synced_from: absPath }),
        contentHash,
      ]);

      synced++;
      components.push(componentType);
    } catch (err) {
      console.error(`[pai-system-sync] error syncing ${relPath}: ${err}`);
      errors++;
    }
  }

  // 2. Sync agent personas from ~/.claude/skills/Agents/
  if (fs.existsSync(config.agentsRoot)) {
    const agentFiles = fs.readdirSync(config.agentsRoot)
      .filter(f => f.endsWith("Context.md"));

    for (const file of agentFiles) {
      const absPath = path.join(config.agentsRoot, file);
      try {
        const content = fs.readFileSync(absPath, "utf8");
        const contentHash = sha256(content);
        const agentName = file.replace("Context.md", "").toLowerCase();
        const key = `pai/agent_persona/${agentName}`;

        const { rows } = await pool.query(
          `SELECT content_hash FROM core.pai_system WHERE key = $1`,
          [key]
        );

        if (rows.length > 0 && rows[0].content_hash === contentHash) {
          skipped++;
          continue;
        }

        await pool.query(`
          INSERT INTO core.pai_system (key, component_type, content, metadata, content_hash, version, created_at, updated_at)
          VALUES ($1, 'agent_persona', $2, $3, $4, 1, NOW(), NOW())
          ON CONFLICT (key) DO UPDATE SET
            content = EXCLUDED.content,
            metadata = EXCLUDED.metadata,
            content_hash = EXCLUDED.content_hash,
            version = core.pai_system.version + 1,
            updated_at = NOW()
        `, [
          key,
          content,
          JSON.stringify({ source_file: file, agent_name: agentName }),
          contentHash,
        ]);

        synced++;
        components.push(`agent_persona:${agentName}`);
      } catch (err) {
        console.error(`[pai-system-sync] error syncing agent ${file}: ${err}`);
        errors++;
      }
    }
  }

  // 3. Sync TELOS files
  if (fs.existsSync(config.telosRoot)) {
    const telosFiles = fs.readdirSync(config.telosRoot)
      .filter(f => f.endsWith(".md"));

    for (const file of telosFiles) {
      const absPath = path.join(config.telosRoot, file);
      try {
        const content = fs.readFileSync(absPath, "utf8");
        const contentHash = sha256(content);
        const telosType = file.replace(".md", "").toLowerCase();
        const key = `pai/telos/${telosType}`;

        const { rows } = await pool.query(
          `SELECT content_hash FROM core.pai_system WHERE key = $1`,
          [key]
        );

        if (rows.length > 0 && rows[0].content_hash === contentHash) {
          skipped++;
          continue;
        }

        await pool.query(`
          INSERT INTO core.pai_system (key, component_type, content, metadata, content_hash, version, created_at, updated_at)
          VALUES ($1, 'telos', $2, $3, $4, 1, NOW(), NOW())
          ON CONFLICT (key) DO UPDATE SET
            content = EXCLUDED.content,
            metadata = EXCLUDED.metadata,
            content_hash = EXCLUDED.content_hash,
            version = core.pai_system.version + 1,
            updated_at = NOW()
        `, [
          key,
          content,
          JSON.stringify({ source_file: file, telos_type: telosType }),
          contentHash,
        ]);

        synced++;
        components.push(`telos:${telosType}`);
      } catch (err) {
        console.error(`[pai-system-sync] error syncing telos ${file}: ${err}`);
        errors++;
      }
    }
  }

  return { synced, skipped, errors, components };
}
