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
    console.log("Usage: intake sync <source|all>");
    console.log("Sources: telegram, signal, slack, email-ms365, email-gmail, sdp-ticket, sdp-task, capture");
    return;
  }

  // Get zone from environment or default
  const zone = (process.env.ZONE as "work" | "home") || "work";

  if (source === "all") {
    // Sync all available sources
    const sources = ["telegram", "signal", "slack", "email-ms365", "email-gmail", "calendar-ms365", "calendar-gmail"];
    for (const s of sources) {
      await syncSource(s, zone);
    }
    return;
  }

  await syncSource(source, zone);
}

async function syncSource(source: string, zone: "work" | "home"): Promise<void> {
  console.log(`\nSyncing ${source} (zone: ${zone})...`);

  try {
    // Dynamic import to avoid loading all adapters upfront
    const adapters = await import("./adapters/index.js");

    // Use BaseAdapter as the common type
    let adapter: { validate: () => Promise<boolean>; sync: (cursor?: string) => Promise<{ success: boolean; itemsProcessed: number; itemsCreated: number; itemsUpdated: number; errors: string[] }> } | null = null;

    switch (source) {
      case "telegram":
        adapter = await adapters.createTelegramAdapter(zone);
        break;
      case "signal":
        adapter = await adapters.createSignalAdapter(zone);
        break;
      case "email-ms365":
        adapter = await adapters.createMS365EmailAdapter(zone);
        break;
      case "email-gmail":
        adapter = await adapters.createGmailAdapter(zone);
        break;
      case "calendar-ms365":
        adapter = await adapters.createMS365CalendarAdapter(zone);
        break;
      case "calendar-gmail":
        adapter = await adapters.createGmailCalendarAdapter(zone);
        break;
      case "slack":
        adapter = await adapters.createSlackAdapter(zone);
        break;
      default:
        console.log(`Adapter for '${source}' not yet implemented.`);
        return;
    }

    if (!adapter) {
      console.log(`Failed to create ${source} adapter (missing credentials?)`);
      return;
    }

    // Validate connection
    const valid = await adapter.validate();
    if (!valid) {
      console.log(`Cannot connect to ${source} API`);
      return;
    }

    // Run sync
    const result = await adapter.sync();

    console.log(`  Processed: ${result.itemsProcessed}`);
    console.log(`  Created: ${result.itemsCreated}`);
    console.log(`  Updated: ${result.itemsUpdated}`);

    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
      for (const err of result.errors.slice(0, 5)) {
        console.log(`    - ${err}`);
      }
    }

    if (result.success) {
      console.log(`  Status: Success`);
    } else {
      console.log(`  Status: Failed`);
    }
  } catch (err) {
    console.error(`Error syncing ${source}:`, err);
  }
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

  // Parse flags
  let verbose = false;
  let skipAI = false;
  let limit = 10;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "-v" || arg === "--verbose") {
      verbose = true;
    } else if (arg === "--skip-ai") {
      skipAI = true;
    } else if (arg === "-n" || arg === "--limit") {
      limit = parseInt(next, 10) || 10;
      i++;
    }
  }

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
    // Load triage module
    const triageMod = await import("./triage/index.js");

    // Check if Python service is available
    const serviceAvailable = await triageMod.isServiceAvailable();
    const backend = serviceAvailable ? "Python service (spaCy + ChromaDB + Instructor)" : "TypeScript (legacy)";

    const items = queryIntake({ untriaged: true, limit });

    if (items.length === 0) {
      console.log("No untriaged items found.");
      return;
    }

    console.log(`Running triage on ${items.length} items...`);
    console.log(`Backend: ${backend}`);
    console.log(`Options: verbose=${verbose}, skipAI=${skipAI}\n`);

    let processed = 0;
    let confirmed = 0;
    let adjusted = 0;
    let overridden = 0;
    let failed = 0;

    for (const item of items) {
      try {
        let result;

        if (serviceAvailable) {
          // Use Python service
          result = await triageMod.triageAndSave(item, { skipAI, verbose });
        } else {
          // Fall back to legacy TypeScript
          result = await triageMod.triageAndSaveLegacy(item, { skipAI, verbose });
        }

        if (!result) {
          failed++;
          continue;
        }

        processed++;

        // Track AI actions (handle both response formats)
        const action = result.action || result.layers?.ai?.action || "unknown";
        if (action === "confirmed") confirmed++;
        else if (action === "adjusted") adjusted++;
        else if (action === "overridden") overridden++;

        if (!verbose) {
          // Compact output
          const quickWin = result.quick_win ? " [QW]" : "";
          console.log(`[${action.toUpperCase()}] ${item.subject || item.id}`);
          console.log(`   → ${result.category}/${result.priority}${quickWin} (${result.confidence}%)`);
        }
      } catch (err) {
        console.error(`Error triaging ${item.id}:`, err);
        failed++;
      }
    }

    console.log(`\n${"─".repeat(60)}`);
    console.log(`Triaged: ${processed}/${items.length}${failed > 0 ? ` (${failed} failed)` : ""}`);
    console.log(`  Confirmed: ${confirmed} | Adjusted: ${adjusted} | Overridden: ${overridden}`);
    return;
  }

  if (action === "one") {
    // Triage a single item by ID
    const itemId = args[1];
    if (!itemId) {
      console.log("Usage: intake triage one <id> [-v]");
      return;
    }

    const items = queryIntake({ limit: 1000 });
    const item = items.find((i) => i.id === itemId || i.id.startsWith(itemId));

    if (!item) {
      console.log(`Item not found: ${itemId}`);
      return;
    }

    const { triageAndSave } = await import("./triage/index.js");
    const result = await triageAndSave(item, { verbose: true, skipAI });

    console.log(`\nResult saved to database.`);
    return;
  }

  console.log(`Usage: intake triage <list|run|one> [options]

Commands:
  list              List untriaged items
  run               Run triage on untriaged items
  one <id>          Triage a single item by ID

Options:
  -v, --verbose     Show detailed layer output
  --skip-ai         Skip AI verification (deterministic only)
  -n, --limit <n>   Limit items to process (default: 10)
`);
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
