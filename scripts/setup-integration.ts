#!/usr/bin/env bun
// setup-integration.ts — Add a new integration to imladris
//
// Interactive flow:
//   1. Show catalog (or filter by category)
//   2. User picks a service
//   3. Install npm package (if Activepieces piece)
//   4. Read auth requirements
//   5. Prompt for credentials
//   6. Store in BWS + Windmill variables
//   7. Add to integration_registry.ts
//   8. Generate a starter Windmill script
//
// Usage:
//   bun run setup-integration.ts                    # interactive
//   bun run setup-integration.ts list               # show all available
//   bun run setup-integration.ts list --category security
//   bun run setup-integration.ts add "Slack"        # add specific
//   bun run setup-integration.ts add "HubSpot" --domain work

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

const CATALOG_PATH = join(import.meta.dir, "integration-catalog.json");
const WINDMILL_DIR = join(import.meta.dir, "../windmill/f");

interface CatalogEntry {
  name: string;
  package: string | null;
  auth: string;
  category: string;
  builtin?: boolean;
  fields: string[];
  notes?: string;
  oauth?: { authorize_url: string; token_url: string; scopes?: string[] };
}

interface Catalog {
  categories: Record<string, string>;
  integrations: CatalogEntry[];
}

function loadCatalog(): Catalog {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// ── Commands ──

function listIntegrations(categoryFilter?: string) {
  const catalog = loadCatalog();
  let entries = catalog.integrations;

  if (categoryFilter) {
    entries = entries.filter(e => e.category === categoryFilter);
  }

  // Group by category
  const grouped: Record<string, CatalogEntry[]> = {};
  for (const e of entries) {
    const cat = catalog.categories[e.category] || e.category;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(e);
  }

  console.log("\nAvailable Integrations:\n");
  for (const [category, items] of Object.entries(grouped)) {
    console.log(`  ${category}`);
    for (const item of items) {
      const authLabel = item.auth === "oauth2" ? "OAuth2" :
                        item.auth === "oauth2_client" ? "OAuth2 Client" :
                        item.auth === "api_key" ? "API Key" :
                        item.auth === "basic" ? "Basic Auth" :
                        item.auth === "iam_role" ? "IAM Role" :
                        item.auth;
      const source = item.builtin ? "built-in" : item.package ? "activepieces" : "custom";
      console.log(`    ${item.name.padEnd(25)} ${authLabel.padEnd(15)} [${source}]`);
    }
    console.log();
  }

  console.log(`Total: ${entries.length} integrations`);
  console.log(`\nCategories: ${Object.keys(catalog.categories).join(", ")}`);
  console.log(`\nTo add: bun run setup-integration.ts add "<name>" --domain <work|personal>`);
}

async function addIntegration(name: string, domain: string = "work") {
  const catalog = loadCatalog();
  const entry = catalog.integrations.find(
    e => e.name.toLowerCase() === name.toLowerCase()
  );

  if (!entry) {
    console.error(`Integration "${name}" not found in catalog.`);
    console.error(`Run: bun run setup-integration.ts list`);
    process.exit(1);
  }

  console.log(`\nAdding integration: ${entry.name}`);
  console.log(`  Auth type: ${entry.auth}`);
  console.log(`  Domain: ${domain}`);
  console.log(`  Package: ${entry.package || "(built-in)"}`);
  console.log(`  Required fields: ${entry.fields.join(", ") || "none"}`);
  console.log();

  const providerSlug = entry.name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_");

  // Step 1: Check for existing secrets in BWS
  console.log("Checking for existing credentials in BWS...");
  const existingSecrets = await checkBwsSecrets(providerSlug, entry.fields);
  const missingFields: string[] = [];
  const existingFields: string[] = [];

  for (const field of entry.fields) {
    const bwsKey = `${providerSlug}-${field.replace(/_/g, "-")}`;
    if (existingSecrets.has(bwsKey)) {
      existingFields.push(field);
      console.log(`  ✓ ${field} — already in BWS as "${bwsKey}"`);
    } else {
      missingFields.push(field);
    }
  }

  if (existingFields.length > 0 && missingFields.length === 0) {
    console.log("\n  All credentials already exist in BWS. Skipping credential prompts.");
  }

  // Step 2: Install npm package if needed
  if (entry.package) {
    console.log(`\nInstalling ${entry.package}...`);
    const proc = Bun.spawn(["bun", "add", entry.package], {
      cwd: join(import.meta.dir, "../windmill"),
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    console.log(`  Installed.`);
  }

  // Step 3: Collect ONLY missing credentials
  const credentials: Record<string, string> = {};
  if (missingFields.length > 0) {
    console.log(`\n  Missing credentials (${missingFields.length}):`);
    for (const field of missingFields) {
      const value = await prompt(`  Enter ${field}: `);
      if (value) credentials[field] = value;
    }
  }

  // Step 4: Store new credentials in BWS (source of truth) + Windmill (cache)
  if (Object.keys(credentials).length > 0) {
    console.log("\nStoring credentials...");

    // 4a: Store in BWS
    for (const [field, value] of Object.entries(credentials)) {
      const bwsKey = `${providerSlug}-${field.replace(/_/g, "-")}`;
      const stored = await storeBwsSecret(bwsKey, value, `${entry.name} ${field}`);
      if (stored) {
        console.log(`  BWS: stored "${bwsKey}"`);
      } else {
        console.log(`  BWS: failed to store "${bwsKey}" (store manually)`);
      }
    }

    // 4b: Store in Windmill variables (cache)
    const wmToken = getWindmillToken();
    const wmBase = "http://127.0.0.1:8000/api/w/imladris";
    const wmFolder = domain === "work" ? "domains/work/infra" : domain;

    for (const [field, value] of Object.entries(credentials)) {
      const varPath = `f/${wmFolder}/${providerSlug}_${field}`;
      const resp = await fetch(`${wmBase}/variables/create`, {
        method: "POST",
        headers: { Authorization: `Bearer ${wmToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          path: varPath,
          value,
          is_secret: true,
          description: `${entry.name} ${field} — added by setup-integration`,
        }),
      });

      if (resp.ok) {
        console.log(`  Windmill: stored ${varPath}`);
      } else {
        const text = await resp.text();
        if (text.includes("already exists")) {
          console.log(`  Windmill: ${varPath} (already exists)`);
        } else {
          console.error(`  Windmill: error ${varPath} — ${resp.status}`);
        }
      }
    }
  } else if (existingFields.length > 0) {
    // Ensure existing BWS secrets are also in Windmill
    console.log("\nSyncing existing BWS secrets to Windmill...");
    const wmToken = getWindmillToken();
    const wmBase = "http://127.0.0.1:8000/api/w/imladris";
    const wmFolder = domain === "work" ? "domains/work/infra" : domain;

    for (const field of existingFields) {
      const bwsKey = `${providerSlug}-${field.replace(/_/g, "-")}`;
      const value = await getBwsSecretValue(bwsKey);
      if (!value) continue;

      const varPath = `f/${wmFolder}/${providerSlug}_${field}`;
      await fetch(`${wmBase}/variables/create`, {
        method: "POST",
        headers: { Authorization: `Bearer ${wmToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: varPath, value, is_secret: true, description: `${entry.name} ${field} — synced from BWS` }),
      });
      console.log(`  Windmill: synced ${varPath}`);
    }
  }

  // Step 4: Handle OAuth if needed
  if (entry.auth === "oauth2" && entry.oauth) {
    console.log("\nOAuth2 setup required.");
    console.log("Run the OAuth dance to get tokens:");
    console.log(`  bun run windmill/f/infra/oauth_dance.ts -- \\`);
    console.log(`    flow=authorization_code \\`);
    console.log(`    provider=${providerSlug} \\`);
    console.log(`    domain=${domain === "work" ? "domains/work/infra" : domain} \\`);
    console.log(`    token_url="${entry.oauth.token_url}" \\`);
    console.log(`    authorize_url="${entry.oauth.authorize_url}" \\`);
    console.log(`    client_id="${credentials.client_id || "<your_client_id>"}" \\`);
    console.log(`    client_secret="${credentials.client_secret || "<your_client_secret>"}"`);
    if (entry.oauth.scopes) {
      console.log(`    scopes="${entry.oauth.scopes.join(" ")}"`);
    }
  }

  // Step 5: Generate starter script
  const scriptPath = `${WINDMILL_DIR}/domains/${domain}/sources/${providerSlug}_helper.ts`;
  if (!existsSync(scriptPath)) {
    const scriptContent = generateStarterScript(entry, providerSlug, domain);
    writeFileSync(scriptPath, scriptContent, "utf8");
    console.log(`\nStarter script created: ${scriptPath}`);
  }

  // Step 6: Print next steps
  console.log(`\n✓ Integration "${entry.name}" added to ${domain} domain.`);
  console.log("\nNext steps:");
  console.log(`  1. ${entry.auth === "oauth2" ? "Complete the OAuth dance above" : "Verify credentials work"}`);
  console.log(`  2. Edit the starter script at: ${scriptPath}`);
  console.log(`  3. Push to Windmill: cd windmill && wmill sync push --yes`);
  console.log(`  4. Add to integration_registry.ts if you want it on the dashboard`);
}

function generateStarterScript(entry: CatalogEntry, slug: string, domain: string): string {
  if (entry.package) {
    return `// ${entry.name} integration — generated by setup-integration
// Uses Activepieces piece: ${entry.package}
// Domain: ${domain}

import { runAction, listActions } from "../../infra/activepieces_adapter.ts";

// List available actions:
// const actions = listActions("${entry.package}");

export async function main(
  action: string = "list_actions",
) {
  if (action === "list_actions") {
    return listActions("${entry.package}");
  }

  // Example: run an action
  // return await runAction("${entry.package}", action, {
  //   auth: { access_token: process.env.${slug.toUpperCase()}_TOKEN },
  //   props: { /* action-specific params */ },
  // });

  return { message: "Edit this script to add your ${entry.name} integration logic" };
}
`;
  }

  return `// ${entry.name} integration — generated by setup-integration
// Direct API integration (no Activepieces piece)
// Domain: ${domain}

export async function main() {
  // TODO: implement ${entry.name} API calls
  // Credentials stored at: f/${domain === "work" ? "domains/work/infra" : domain}/${slug}_*
  return { message: "Edit this script to add your ${entry.name} integration logic" };
}
`;
}

function getWindmillToken(): string {
  try {
    const remotes = readFileSync(join(process.env.HOME || "", ".config/windmill/remotes.ndjson"), "utf8");
    const first = JSON.parse(remotes.trim().split("\n")[0]);
    return first.token;
  } catch {
    return "";
  }
}

// ── BWS helpers ──

async function checkBwsSecrets(providerSlug: string, fields: string[]): Promise<Set<string>> {
  // Check which BWS secrets already exist for this provider
  const existing = new Set<string>();
  try {
    const proc = Bun.spawn(["bws", "secret", "list"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const secrets: Array<{ key: string }> = JSON.parse(output);

    const allKeys = new Set(secrets.map(s => s.key));

    // Check both naming conventions: provider-field and legacy patterns
    for (const field of fields) {
      const bwsKey = `${providerSlug}-${field.replace(/_/g, "-")}`;
      if (allKeys.has(bwsKey)) existing.add(bwsKey);

      // Also check common legacy patterns
      const altKeys = [
        `api-${providerSlug}-${field.replace(/_/g, "-")}`,
        `investigate-${providerSlug}-${field.replace(/_/g, "-")}`,
        `devops-${providerSlug}-${field.replace(/_/g, "-")}`,
      ];
      for (const alt of altKeys) {
        if (allKeys.has(alt)) existing.add(alt);
      }
    }
  } catch {
    // BWS not available — return empty set (will prompt for all fields)
  }
  return existing;
}

async function storeBwsSecret(key: string, value: string, note: string): Promise<boolean> {
  try {
    // BWS create secret requires a project ID — get the default one
    const proc = Bun.spawn(
      ["bws", "secret", "create", key, value, "--note", note],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function getBwsSecretValue(key: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["bws", "secret", "list"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const secrets: Array<{ key: string; value: string }> = JSON.parse(output);
    const match = secrets.find(s => s.key === key);
    return match?.value || null;
  } catch {
    return null;
  }
}

// ── Main ──

const args = process.argv.slice(2);
const cmd = args[0] || "list";

if (cmd === "list") {
  const catIdx = args.indexOf("--category");
  const category = catIdx !== -1 ? args[catIdx + 1] : undefined;
  listIntegrations(category);
} else if (cmd === "add") {
  const name = args[1];
  const domIdx = args.indexOf("--domain");
  const domain = domIdx !== -1 ? args[domIdx + 1] : "work";
  if (!name) {
    console.error("Usage: setup-integration add <name> [--domain work|personal]");
    process.exit(1);
  }
  await addIntegration(name, domain);
} else {
  console.log("Usage:");
  console.log("  setup-integration list [--category <cat>]");
  console.log("  setup-integration add <name> [--domain work|personal]");
}
