#!/usr/bin/env bun
/**
 * Intake CLI
 *
 * Universal intake system for personal information triage.
 * Commands: sync, query, triage, stats, embed
 */

import {
  getDb,
  initializeSchema,
  closeDb,
  queryIntake,
  getStats,
  upsertIntake,
  updateIntakeStatus,
  updateIntakeEmbedding,
  type Zone,
  type QueryOptions,
} from "./db/database.js";

// Lazy-load embeddings to avoid onnxruntime dependency unless needed
async function loadEmbeddings() {
  return import("./embeddings/pipeline.js");
}

// =============================================================================
// CLI Commands
// =============================================================================

const commands: Record<string, (args: string[]) => Promise<void>> = {
  init,
  sync,
  query: queryCmd,
  triage,
  stats,
  embed: embedCmd,
  help,
};

// =============================================================================
// Command Implementations
// =============================================================================

async function init(_args: string[]): Promise<void> {
  console.log("Initializing intake database...");
  initializeSchema();
  console.log("Database initialized at /data/.cache/intake/intake.sqlite");
}

async function sync(args: string[]): Promise<void> {
  const source = args[0];
  if (!source) {
    console.log("Usage: intake sync <source>");
    console.log("Sources: slack, telegram, email-ms365, email-gmail, sdp-ticket, sdp-task, capture");
    return;
  }

  console.log(`Syncing ${source}...`);
  // TODO: Implement source-specific sync adapters
  console.log("Sync adapters not yet implemented. See lib/intake/adapters/");
}

async function queryCmd(args: string[]): Promise<void> {
  const options: QueryOptions = {};

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--zone":
      case "-z":
        options.zone = next as Zone;
        i++;
        break;
      case "--source":
      case "-s":
        options.source = next?.split(",");
        i++;
        break;
      case "--status":
        options.status = next?.split(",");
        i++;
        break;
      case "--limit":
      case "-n":
        options.limit = parseInt(next, 10);
        i++;
        break;
      case "--untriaged":
      case "-u":
        options.untriaged = true;
        break;
      case "--quick-wins":
      case "-q":
        options.quick_wins = true;
        break;
      case "--priority":
      case "-p":
        options.priority = next?.split(",");
        i++;
        break;
    }
  }

  // Default zone from environment
  if (!options.zone && process.env.ZONE) {
    options.zone = process.env.ZONE as Zone;
  }

  const items = queryIntake(options);

  if (items.length === 0) {
    console.log("No items found.");
    return;
  }

  console.log(`Found ${items.length} items:\n`);

  for (const item of items) {
    const zoneBadge = item.zone === "home" ? "🏠" : "💼";
    console.log(`${zoneBadge} [${item.source}] ${item.subject || "(no subject)"}`);
    console.log(`   ID: ${item.id}`);
    console.log(`   From: ${item.from_name || item.from_address || "unknown"}`);
    console.log(`   Status: ${item.status} | Updated: ${item.updated_at}`);
    if (item.body) {
      const preview = item.body.substring(0, 100).replace(/\n/g, " ");
      console.log(`   ${preview}${item.body.length > 100 ? "..." : ""}`);
    }
    console.log();
  }
}

async function triage(args: string[]): Promise<void> {
  const action = args[0];

  if (!action || action === "list") {
    // List untriaged items
    const items = queryIntake({ untriaged: true, limit: 20 });
    console.log(`${items.length} items need triage:\n`);

    for (const item of items) {
      console.log(`[${item.source}] ${item.subject || "(no subject)"}`);
      console.log(`   ID: ${item.id}`);
    }
    return;
  }

  if (action === "run") {
    console.log("Running triage on untriaged items...");
    // TODO: Implement rules engine + AI triage
    console.log("Triage engine not yet implemented. See lib/intake/triage/");
    return;
  }

  console.log("Usage: intake triage [list|run]");
}

async function stats(args: string[]): Promise<void> {
  const zone = args[0] as Zone | undefined;
  const statistics = getStats(zone);

  console.log("=== Intake Statistics ===\n");

  if (zone) {
    console.log(`Zone: ${zone}\n`);
  }

  console.log(`Total items: ${statistics.total}`);
  console.log(`Untriaged: ${statistics.untriaged}`);
  console.log(`Quick wins: ${statistics.quick_wins}\n`);

  console.log("By Zone:");
  for (const [z, count] of Object.entries(statistics.by_zone)) {
    const badge = z === "home" ? "🏠" : "💼";
    console.log(`  ${badge} ${z}: ${count}`);
  }
  console.log();

  console.log("By Source:");
  for (const [source, count] of Object.entries(statistics.by_source)) {
    console.log(`  ${source}: ${count}`);
  }
  console.log();

  console.log("By Status:");
  for (const [status, count] of Object.entries(statistics.by_status)) {
    console.log(`  ${status}: ${count}`);
  }
  console.log();

  if (Object.keys(statistics.by_priority).length > 0) {
    console.log("By Priority:");
    for (const [priority, count] of Object.entries(statistics.by_priority)) {
      console.log(`  ${priority}: ${count}`);
    }
  }
}

async function embedCmd(args: string[]): Promise<void> {
  const action = args[0];

  // Lazy-load embeddings module only when needed
  const { embed, prepareIntakeText } = await loadEmbeddings();

  if (action === "backfill") {
    console.log("Backfilling embeddings for items without them...");

    const items = queryIntake({ limit: 1000 });
    const needsEmbedding = items.filter((i) => !i.embedding);

    console.log(`Found ${needsEmbedding.length} items needing embeddings.`);

    let processed = 0;
    for (const item of needsEmbedding) {
      const text = prepareIntakeText(item);
      const embedding = await embed(text);
      updateIntakeEmbedding(item.id, embedding);
      processed++;

      if (processed % 10 === 0) {
        console.log(`Processed ${processed}/${needsEmbedding.length}`);
      }
    }

    console.log(`Done. Embedded ${processed} items.`);
    return;
  }

  if (action === "test") {
    const text = args.slice(1).join(" ") || "This is a test message for embedding.";
    console.log(`Embedding: "${text}"`);
    const embedding = await embed(text);
    console.log(`Dimension: ${embedding.length}`);
    console.log(`First 5 values: [${Array.from(embedding.slice(0, 5)).map((v) => v.toFixed(4)).join(", ")}]`);
    return;
  }

  console.log("Usage: intake embed <backfill|test> [text]");
}

async function help(_args: string[]): Promise<void> {
  console.log(`
intake - Universal intake system for personal information triage

USAGE:
  intake <command> [options]

COMMANDS:
  init                  Initialize the database
  sync <source>         Sync from a source (slack, telegram, email-*, sdp-*, capture)
  query [options]       Query intake items
  triage [list|run]     List untriaged items or run triage
  stats [zone]          Show statistics (optionally filtered by zone)
  embed <backfill|test> Manage embeddings
  help                  Show this help

QUERY OPTIONS:
  -z, --zone <zone>     Filter by zone (work|home)
  -s, --source <src>    Filter by source (comma-separated)
  --status <status>     Filter by status (comma-separated)
  -n, --limit <n>       Limit results (default: 50)
  -u, --untriaged       Show only untriaged items
  -q, --quick-wins      Show only quick wins
  -p, --priority <p>    Filter by priority (comma-separated: P0,P1,P2,P3)

ENVIRONMENT:
  ZONE                  Default zone (work|home)
  INTAKE_DB             Database path (default: /data/.cache/intake/intake.sqlite)

EXAMPLES:
  intake init
  intake query -z work -n 10
  intake query --untriaged --source slack,telegram
  intake stats work
  intake embed backfill
`);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    await help([]);
    return;
  }

  if (command !== "help" && command !== "init") {
    // Initialize database for all commands except help
    initializeSchema();
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error("Run 'intake help' for usage.");
    process.exit(1);
  }

  try {
    await handler(args);
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
