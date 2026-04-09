#!/usr/bin/env bun
// ============================================================
// install.ts — Imladris Installation Wizard
//
// Covers all scenarios:
//   1. Fresh full install (Claude Code + PAI + Windmill + Palantír)
//   2. Palantír-only (MCP gateway, no Claude Code)
//   3. Join existing hive (connect to peer instances)
//   4. Add integrations to existing install
//   5. Hydrate from existing Palantír (restore from backup)
//
// Usage: bun run install.ts
// ============================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

const HOME = process.env.HOME || "/home/ec2-user";
const SCRIPT_DIR = import.meta.dir;
const REPO_DIR = join(SCRIPT_DIR, "..");

interface InstallConfig {
  mode: string;
  user_name: string;
  instance_name: string;
  domains: string[];
  secret_manager: string;
  tailscale_ip?: string;
  peers: Array<{ name: string; host: string; schemas: string[] }>;
  postgres_password?: string;
  windmill_password?: string;
  installed_at: string;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function promptChoice(question: string, options: string[]): Promise<string> {
  console.log(`\n${question}\n`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i]}`);
  }
  const choice = await prompt(`\nChoose (1-${options.length}): `);
  return options[parseInt(choice) - 1] || options[0];
}

async function promptYesNo(question: string, defaultYes: boolean = true): Promise<boolean> {
  const hint = defaultYes ? "(Y/n)" : "(y/N)";
  const answer = await prompt(`${question} ${hint}: `);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

// ══════════════════════════════════════════════════════════════
// MAIN WIZARD
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   Imladris Installation Wizard                               ║
║   Cloud workstation + PAI + Palantír knowledge mesh          ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Step 1: What are we doing?
  const mode = await promptChoice("What would you like to do?", [
    "Fresh full install (Claude Code + PAI + Windmill + Palantír)",
    "Palantír-only (MCP knowledge gateway, no Claude Code)",
    "Join an existing hive (connect to peer Palantír instances)",
    "Hydrate from existing Palantír (restore full PAI from backup)",
    "Add integrations to existing install",
  ]);

  const config: InstallConfig = {
    mode,
    user_name: "",
    instance_name: "",
    domains: [],
    secret_manager: "",
    peers: [],
    installed_at: new Date().toISOString(),
  };

  // Step 2: Who are you?
  console.log("\n── Identity ──");
  config.user_name = await prompt("Your name: ");
  config.instance_name = await prompt("Name for this instance (e.g., imladris, home-server, work-laptop): ");

  // Step 3: Which domains?
  console.log("\n── Domains ──");
  console.log("  Domains partition your knowledge. Each domain is a Postgres schema.");
  console.log("  'core' is always included (PAI methodology + learnings).\n");

  const wantWork = await promptYesNo("  Include 'work' domain? (Buxton/employer operational data)");
  const wantPersonal = await promptYesNo("  Include 'personal' domain? (Home, personal projects)");
  const wantCustom = await promptYesNo("  Add a custom domain?", false);

  config.domains = ["core", "shared"];
  if (wantWork) config.domains.push("work");
  if (wantPersonal) config.domains.push("personal");
  if (wantCustom) {
    const customName = await prompt("  Custom domain name (lowercase, no spaces): ");
    if (customName) config.domains.push(customName);
  }

  // Step 4: Secret manager
  console.log("\n── Secret Manager ──");
  config.secret_manager = await promptChoice("Where should credentials be stored?", [
    "Bitwarden Secrets Manager (BWS)",
    "AWS Secrets Manager",
    "AWS SSM Parameter Store",
    "HashiCorp Vault",
    "1Password (via CLI)",
    "Windmill variables only (no external vault)",
  ]);

  // Route based on mode
  if (mode.startsWith("Fresh")) {
    await freshInstall(config);
  } else if (mode.startsWith("Palantír")) {
    await palantirOnly(config);
  } else if (mode.startsWith("Join")) {
    await joinHive(config);
  } else if (mode.startsWith("Hydrate")) {
    await hydrateFromPeer(config);
  } else if (mode.startsWith("Add")) {
    await addIntegrations(config);
  }

  // Save config
  const configPath = join(REPO_DIR, ".install-config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`\nInstallation config saved to: ${configPath}`);
}

// ══════════════════════════════════════════════════════════════
// MODE 1: FRESH FULL INSTALL
// ══════════════════════════════════════════════════════════════

async function freshInstall(config: InstallConfig) {
  console.log("\n══ Fresh Full Install ══\n");

  // Postgres password
  config.postgres_password = generatePassword();
  config.windmill_password = generatePassword();

  // Tailscale
  console.log("── Tailscale ──");
  const hasTailscale = await promptYesNo("Is Tailscale installed?");
  if (hasTailscale) {
    config.tailscale_ip = await prompt("  Tailscale IP (100.x.x.x): ");
  } else {
    console.log("  Install Tailscale first: https://tailscale.com/download");
    console.log("  Then re-run this wizard.");
    return;
  }

  // Hive peers
  const wantPeers = await promptYesNo("\nConnect to existing Palantír instances?", false);
  if (wantPeers) {
    await configurePeers(config);
  }

  // Integrations
  const wantIntegrations = await promptYesNo("\nSet up integrations now?", false);

  // Summary
  console.log("\n══ Installation Plan ══\n");
  console.log(`  Instance:        ${config.instance_name}`);
  console.log(`  User:            ${config.user_name}`);
  console.log(`  Domains:         ${config.domains.join(", ")}`);
  console.log(`  Secret Manager:  ${config.secret_manager}`);
  console.log(`  Tailscale:       ${config.tailscale_ip || "not configured"}`);
  console.log(`  Hive Peers:      ${config.peers.length > 0 ? config.peers.map(p => p.name).join(", ") : "none"}`);
  console.log(`\n  Components to install:`);
  console.log(`    ✓ Docker + Docker Compose`);
  console.log(`    ✓ PostgreSQL 16 (pgvector, AGE, pg_cron, pgml)`);
  console.log(`    ✓ Windmill automation engine`);
  console.log(`    ✓ Palantír MCP Gateway`);
  console.log(`    ✓ PAI sync daemon`);
  console.log(`    ✓ Claude Code + PAI`);

  const proceed = await promptYesNo("\nProceed with installation?");
  if (!proceed) { console.log("Cancelled."); return; }

  // Execute installation steps
  console.log("\n── Installing ──\n");

  await step("Creating .env file", async () => {
    writeFileSync(join(REPO_DIR, ".env"), [
      `WINDMILL_DB_PASSWORD=${config.windmill_password}`,
      `WINDMILL_ADMIN_SECRET=${generatePassword()}`,
    ].join("\n"));
  });

  await step("Building Postgres image (pgvector + AGE + pg_cron + pgml)", async () => {
    await run("docker", ["build", "-t", "imladris/postgres:pg16", "docker/postgres-pgml/"]);
  });

  await step("Starting Docker Compose stack", async () => {
    await run("docker", ["compose", "up", "-d"]);
  });

  await step("Waiting for Postgres to be ready", async () => {
    for (let i = 0; i < 30; i++) {
      const proc = Bun.spawn(["docker", "exec", "imladris-windmill_db-1", "pg_isready", "-U", "postgres"], { stdout: "pipe", stderr: "pipe" });
      if (await proc.exited === 0) return;
      await Bun.sleep(2000);
    }
    throw new Error("Postgres did not start in 60 seconds");
  });

  await step("Creating pai database", async () => {
    await dockerPsql("CREATE DATABASE pai TEMPLATE template1;");
  });

  await step("Creating schemas", async () => {
    const sqlFile = join(REPO_DIR, "docker/postgres-pgml/docker-entrypoint-initdb.d/01-create-pai-database.sql");
    if (existsSync(sqlFile)) {
      await run("docker", ["exec", "-i", "imladris-windmill_db-1", "psql", "-U", "postgres", "-d", "pai"], { stdin: readFileSync(sqlFile) });
    }
    const schemaFile = join(REPO_DIR, "scripts/palantir/schemas/phase2d-multi-schema.sql");
    if (existsSync(schemaFile)) {
      await run("docker", ["exec", "-i", "imladris-windmill_db-1", "psql", "-U", "postgres", "-d", "pai"], { stdin: readFileSync(schemaFile) });
    }
  });

  await step("Creating extensions", async () => {
    const sqlFile = join(REPO_DIR, "docker/postgres-pgml/docker-entrypoint-initdb.d/02-create-extensions.sql");
    if (existsSync(sqlFile)) {
      await run("docker", ["exec", "-i", "imladris-windmill_db-1", "psql", "-U", "postgres", "-d", "pai"], { stdin: readFileSync(sqlFile) });
    }
  });

  await step("Installing Palantír SQL functions", async () => {
    const sqlFile = join(REPO_DIR, "scripts/palantir/setup.sql");
    if (existsSync(sqlFile)) {
      await run("docker", ["exec", "-i", "imladris-windmill_db-1", "psql", "-U", "postgres", "-d", "pai"], { stdin: readFileSync(sqlFile) });
    }
  });

  await step("Configuring sync daemon", async () => {
    mkdirSync("/etc/pai-sync", { recursive: true });
    const syncPwd = generatePassword();
    await dockerPsql(`ALTER ROLE pai_sync PASSWORD '${syncPwd}';`, "pai");
    writeFileSync("/etc/pai-sync/env", [
      `POSTGRES_URL=postgresql://pai_sync:${syncPwd}@127.0.0.1:5432/pai`,
      `PAI_SYNC_WATCH_ROOT=${HOME}/.claude/MEMORY`,
      `PAI_SYNC_MACHINE_ID=${config.instance_name}`,
      `PAI_EMBED_BATCH_SIZE=20`,
      `PAI_EMBED_INTERVAL_MS=60000`,
    ].join("\n"));
  });

  await step("Installing sync daemon systemd service", async () => {
    const serviceFile = join(REPO_DIR, "scripts/pai-sync/pai-sync-daemon.service");
    if (existsSync(serviceFile)) {
      await run("cp", [serviceFile, "/etc/systemd/system/"]);
      await run("systemctl", ["daemon-reload"]);
      await run("systemctl", ["enable", "--now", "pai-sync-daemon"]);
    }
  });

  await step("Pushing Windmill scripts", async () => {
    // Get a fresh Windmill token
    const tokenProc = Bun.spawn(["docker", "exec", "imladris-windmill_db-1", "psql", "-U", "postgres", "-d", "windmill", "-t", "-A", "-c", "SELECT token FROM token ORDER BY created_at DESC LIMIT 1;"], { stdout: "pipe" });
    const token = (await new Response(tokenProc.stdout).text()).trim();
    if (token) {
      await run("wmill", ["workspace", "add", "imladris", "imladris", "http://localhost:8000/", "--token", token]);
      await run("wmill", ["sync", "push", "--yes"], { cwd: join(REPO_DIR, "windmill") });
    }
  });

  // Configure hive peers if requested
  if (config.peers.length > 0) {
    await step("Configuring hive replication", async () => {
      await setupHiveReplication(config);
    });
  }

  await step("Generating PAI settings", async () => {
    await generatePaiSettings(config);
  });

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   ✓ Installation complete!                                   ║
║                                                              ║
║   Instance:  ${config.instance_name.padEnd(45)}║
║   Domains:   ${config.domains.join(", ").padEnd(45)}║
║   Palantír:  localhost:3200 (MCP)                            ║
║   Windmill:  localhost:8000                                  ║
║   Dashboard: localhost:3100                                  ║
║                                                              ║
║   Next steps:                                                ║
║   1. Run: bun run scripts/setup-integration.ts               ║
║      to add your first data source                           ║
║   2. Start Claude Code: claude                               ║
║   3. Visit dashboard: https://${(config.instance_name + ".tailnet").padEnd(25)}║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
}

// ══════════════════════════════════════════════════════════════
// MODE 2: PALANTÍR-ONLY
// ══════════════════════════════════════════════════════════════

async function palantirOnly(config: InstallConfig) {
  console.log("\n══ Palantír-Only Install ══\n");
  console.log("  No Claude Code, no PAI hooks, no sync daemon.");
  console.log("  Just Postgres + Palantír MCP server.");
  console.log("  Knowledge enters through MCP tool calls only.\n");

  const wantWindmill = await promptYesNo("Include Windmill? (automation tools, cron jobs)", false);
  const wantPeers = await promptYesNo("Connect to existing Palantír instances?", false);

  if (wantPeers) {
    await configurePeers(config);
  }

  const proceed = await promptYesNo("\nProceed?");
  if (!proceed) return;

  console.log("\n── Installing ──\n");

  await step("Building Postgres image", async () => {
    await run("docker", ["build", "-t", "imladris/postgres:pg16", "docker/postgres-pgml/"]);
  });

  // Start minimal stack (just Postgres, optionally Windmill)
  await step("Starting Postgres", async () => {
    config.windmill_password = generatePassword();
    writeFileSync(join(REPO_DIR, ".env"), `WINDMILL_DB_PASSWORD=${config.windmill_password}\nWINDMILL_ADMIN_SECRET=${generatePassword()}\n`);
    if (wantWindmill) {
      await run("docker", ["compose", "up", "-d"]);
    } else {
      await run("docker", ["compose", "up", "-d", "windmill_db"]);
    }
  });

  await step("Waiting for Postgres", async () => {
    for (let i = 0; i < 30; i++) {
      const proc = Bun.spawn(["docker", "exec", "imladris-windmill_db-1", "pg_isready", "-U", "postgres"], { stdout: "pipe", stderr: "pipe" });
      if (await proc.exited === 0) return;
      await Bun.sleep(2000);
    }
  });

  await step("Creating database + schemas", async () => {
    await dockerPsql("CREATE DATABASE pai TEMPLATE template1;");
    for (const file of ["01-create-pai-database.sql", "02-create-extensions.sql"]) {
      const sqlPath = join(REPO_DIR, "docker/postgres-pgml/docker-entrypoint-initdb.d", file);
      if (existsSync(sqlPath)) {
        await run("docker", ["exec", "-i", "imladris-windmill_db-1", "psql", "-U", "postgres", "-d", "pai"], { stdin: readFileSync(sqlPath) });
      }
    }
    const schemaFile = join(REPO_DIR, "scripts/palantir/schemas/phase2d-multi-schema.sql");
    if (existsSync(schemaFile)) {
      await run("docker", ["exec", "-i", "imladris-windmill_db-1", "psql", "-U", "postgres", "-d", "pai"], { stdin: readFileSync(schemaFile) });
    }
  });

  await step("Installing Palantír", async () => {
    const sqlFile = join(REPO_DIR, "scripts/palantir/setup.sql");
    if (existsSync(sqlFile)) {
      await run("docker", ["exec", "-i", "imladris-windmill_db-1", "psql", "-U", "postgres", "-d", "pai"], { stdin: readFileSync(sqlFile) });
    }
  });

  if (config.peers.length > 0) {
    await step("Configuring hive replication", async () => {
      await setupHiveReplication(config);
    });
  }

  console.log(`\n  ✓ Palantír-only install complete.`);
  console.log(`  Start: cd scripts/palantir && POSTGRES_URL=postgresql://postgres:${config.windmill_password}@127.0.0.1:5432/pai bun run server.ts`);
}

// ══════════════════════════════════════════════════════════════
// MODE 3: JOIN HIVE
// ══════════════════════════════════════════════════════════════

async function joinHive(config: InstallConfig) {
  console.log("\n══ Join Existing Hive ══\n");

  await configurePeers(config);

  if (config.peers.length === 0) {
    console.log("  No peers configured. Nothing to do.");
    return;
  }

  // Check if Postgres is running locally
  const pgReady = Bun.spawnSync(["docker", "exec", "imladris-windmill_db-1", "pg_isready", "-U", "postgres"]);
  if (pgReady.exitCode !== 0) {
    console.log("  Local Postgres is not running. Start docker compose first.");
    return;
  }

  const proceed = await promptYesNo("\nSet up replication now?");
  if (!proceed) return;

  await setupHiveReplication(config);
  console.log("\n  ✓ Hive replication configured. Data will sync automatically.");
}

// ══════════════════════════════════════════════════════════════
// MODE 4: HYDRATE FROM PEER
// ══════════════════════════════════════════════════════════════

async function hydrateFromPeer(config: InstallConfig) {
  console.log("\n══ Hydrate from Existing Palantír ══\n");
  console.log("  This pulls all knowledge from a peer's Postgres into your local files.\n");

  const peerHost = await prompt("  Peer Tailscale IP (100.x.x.x): ");
  const peerPort = await prompt("  Peer Postgres port (5432): ") || "5432";
  const peerPassword = await prompt("  Peer Postgres password: ");

  const peerUrl = `postgresql://postgres:${peerPassword}@${peerHost}:${peerPort}/pai`;

  console.log(`\n  Connecting to ${peerHost}:${peerPort}...`);

  const proceed = await promptYesNo("  This will write files to ~/.claude/MEMORY/ and ~/.claude/PAI/. Proceed?");
  if (!proceed) return;

  // Use the pull-full script
  process.env.POSTGRES_URL = peerUrl;
  const { pullFull } = await import("./pai-sync/pull-full.ts");
  const stats = await pullFull();

  console.log(`\n  ✓ Hydration complete.`);
  console.log(`    Memory files: ${stats.memory_files}`);
  console.log(`    JSONL files: ${stats.jsonl_files} (${stats.jsonl_lines} lines)`);
  console.log(`    Methodology: ${stats.pai_system_files}`);
  console.log(`    Personas: ${stats.agent_personas}`);
}

// ══════════════════════════════════════════════════════════════
// MODE 5: ADD INTEGRATIONS
// ══════════════════════════════════════════════════════════════

async function addIntegrations(config: InstallConfig) {
  console.log("\n  Launching integration setup wizard...\n");
  const proc = Bun.spawn(["bun", "run", join(SCRIPT_DIR, "setup-integration.ts"), "list"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  console.log("\n  To add a specific integration:");
  console.log('  bun run scripts/setup-integration.ts add "<name>" --domain work');
}

// ══════════════════════════════════════════════════════════════
// HIVE REPLICATION SETUP
// ══════════════════════════════════════════════════════════════

async function configurePeers(config: InstallConfig) {
  let addMore = true;
  while (addMore) {
    console.log("\n  ── Add Hive Peer ──");
    const name = await prompt("  Peer name (e.g., home, work-laptop): ");
    const host = await prompt("  Peer Tailscale IP (100.x.x.x): ");

    console.log(`\n  Which schemas to replicate with ${name}?`);
    const schemas: string[] = ["core", "shared"]; // always
    for (const domain of config.domains.filter(d => d !== "core" && d !== "shared")) {
      const sync = await promptYesNo(`    Replicate '${domain}' with ${name}?`);
      if (sync) schemas.push(domain);
    }

    config.peers.push({ name, host, schemas });
    console.log(`  Added peer: ${name} (${host}) — schemas: ${schemas.join(", ")}`);

    addMore = await promptYesNo("\n  Add another peer?", false);
  }
}

async function setupHiveReplication(config: InstallConfig) {
  // Enable logical WAL level
  await dockerPsql("ALTER SYSTEM SET wal_level = logical;", "pai");
  console.log("  Set wal_level = logical (requires Postgres restart)");

  // Create replication user
  const hivePwd = generatePassword();
  await dockerPsql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hive_sync') THEN
        CREATE ROLE hive_sync WITH REPLICATION LOGIN PASSWORD '${hivePwd}';
      END IF;
    END $$;
  `, "pai");

  // Grant schema access
  for (const schema of ["core", "shared", "personal"]) {
    await dockerPsql(`
      GRANT USAGE ON SCHEMA ${schema} TO hive_sync;
      GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO hive_sync;
    `, "pai").catch(() => {}); // schema may not exist
  }

  // Create publications for each peer
  for (const peer of config.peers) {
    const pubName = `hive_to_${peer.name.replace(/[^a-z0-9]/g, "_")}`;
    const schemaClauses = peer.schemas.map(s => `TABLES IN SCHEMA ${s}`).join(", ");

    await dockerPsql(`
      DROP PUBLICATION IF EXISTS ${pubName};
      CREATE PUBLICATION ${pubName} FOR ${schemaClauses};
    `, "pai");

    console.log(`  Publication '${pubName}' created for schemas: ${peer.schemas.join(", ")}`);
    console.log(`  Peer connection string for ${peer.name}:`);
    console.log(`    host=${config.tailscale_ip || "100.x.x.x"} port=5432 dbname=pai user=hive_sync password=${hivePwd}`);
  }

  console.log("\n  NOTE: Restart Postgres to apply wal_level change:");
  console.log("    docker compose restart windmill_db");
  console.log("\n  Then on each peer, run:");
  console.log('    bun run install.ts  →  "Join an existing hive"');
}

// ══════════════════════════════════════════════════════════════
// PAI SETTINGS GENERATION
// ══════════════════════════════════════════════════════════════

async function generatePaiSettings(config: InstallConfig) {
  // Generate a basic settings.json with Palantír MCP registered
  const settingsPath = `${HOME}/.claude/settings.json`;
  if (existsSync(settingsPath)) {
    console.log("  settings.json already exists — adding Palantír MCP server");
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (!settings.mcpServers) settings.mcpServers = {};
      settings.mcpServers.palantir = {
        command: "bun",
        args: ["run", join(REPO_DIR, "scripts/palantir/server.ts")],
        env: {
          WINDMILL_TOKEN: "",  // will be populated
          WINDMILL_BASE: "http://localhost:8000",
          WINDMILL_WORKSPACE: "imladris",
        },
      };
      if (config.user_name && settings.principal) {
        settings.principal.name = config.user_name;
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch {
      console.log("  Could not update settings.json — add Palantír MCP server manually");
    }
  }
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function generatePassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function run(cmd: string, args: string[], opts?: { cwd?: string; stdin?: Buffer }): Promise<void> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts?.cwd || REPO_DIR,
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts?.stdin ? new Response(opts.stdin) : undefined,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${cmd} ${args[0]} failed (${exitCode}): ${stderr.slice(0, 200)}`);
  }
}

async function dockerPsql(sql: string, db: string = "postgres"): Promise<void> {
  const proc = Bun.spawn(
    ["docker", "exec", "-i", "imladris-windmill_db-1", "psql", "-U", "postgres", "-d", db, "-c", sql],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
}

async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  ${name}...`);
  try {
    await fn();
    console.log(" ✓");
  } catch (err: any) {
    console.log(` ✗ (${err.message?.slice(0, 80)})`);
  }
}

// ── Run ──
main().catch(err => {
  console.error(`\nFatal error: ${err.message}`);
  process.exit(1);
});
