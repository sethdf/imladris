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
const CONFIG_PATH = join(import.meta.dir, ".integration-config.json");

// ── Secret Manager Configuration ──

interface SecretManagerConfig {
  provider: string;  // "bws" | "aws_sm" | "hashicorp" | "1password" | "ssm" | "windmill_only"
  configured_at: string;
}

const SECRET_MANAGERS = [
  { id: "bws", name: "Bitwarden Secrets Manager (BWS)", cmd: "bws", desc: "CLI-based, open source. Current default." },
  { id: "aws_sm", name: "AWS Secrets Manager", cmd: "aws", desc: "AWS-native, pay per secret. Uses IAM role." },
  { id: "ssm", name: "AWS SSM Parameter Store", cmd: "aws", desc: "AWS-native, free tier. Uses IAM role." },
  { id: "hashicorp", name: "HashiCorp Vault", cmd: "vault", desc: "Self-hosted or HCP Cloud. Industry standard." },
  { id: "1password", name: "1Password (via CLI)", cmd: "op", desc: "Uses `op read` CLI. Requires 1Password account." },
  { id: "cyberark", name: "CyberArk", cmd: null, desc: "Enterprise PAM. Requires CyberArk API access." },
  { id: "windmill_only", name: "Windmill variables only (no external vault)", cmd: null, desc: "Secrets stored in Windmill DB only. No external backup." },
];

function loadConfig(): SecretManagerConfig | null {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(config: SecretManagerConfig) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

async function chooseSecretManager(): Promise<string> {
  const existing = loadConfig();
  if (existing) {
    const mgr = SECRET_MANAGERS.find(m => m.id === existing.provider);
    console.log(`\nSecret manager: ${mgr?.name || existing.provider} (configured ${existing.configured_at})`);
    const change = await prompt("  Change secret manager? (y/N): ");
    if (change.toLowerCase() !== "y") return existing.provider;
  }

  console.log("\nWhere should secrets be stored?\n");
  for (let i = 0; i < SECRET_MANAGERS.length; i++) {
    const m = SECRET_MANAGERS[i];
    const available = m.cmd ? (await isCommandAvailable(m.cmd) ? "✓ installed" : "✗ not found") : "";
    console.log(`  ${i + 1}. ${m.name}`);
    console.log(`     ${m.desc} ${available ? `[${available}]` : ""}`);
  }

  const choice = await prompt(`\nChoose (1-${SECRET_MANAGERS.length}): `);
  const idx = parseInt(choice) - 1;
  const selected = SECRET_MANAGERS[idx] || SECRET_MANAGERS[0];

  saveConfig({ provider: selected.id, configured_at: new Date().toISOString() });
  console.log(`\n  Secret manager set to: ${selected.name}`);
  return selected.id;
}

async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
  } catch { return false; }
}

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

  // Step 0: Choose or confirm secret manager
  const secretMgr = await chooseSecretManager();

  // Step 1: Check for existing secrets
  console.log(`\nChecking for existing credentials in ${SECRET_MANAGERS.find(m => m.id === secretMgr)?.name || secretMgr}...`);
  const existingSecrets = await checkExistingSecrets(secretMgr, providerSlug, entry.fields);
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

    // 4a: Store in secret manager
    for (const [field, value] of Object.entries(credentials)) {
      const secretKey = `${providerSlug}-${field.replace(/_/g, "-")}`;
      const stored = await storeSecret(secretMgr, secretKey, value, `${entry.name} ${field}`);
      const mgrName = SECRET_MANAGERS.find(m => m.id === secretMgr)?.name || secretMgr;
      if (stored) {
        console.log(`  ${mgrName}: stored "${secretKey}"`);
      } else {
        console.log(`  ${mgrName}: failed to store "${secretKey}" (store manually)`);
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
    // Ensure existing secrets are also in Windmill
    console.log("\nSyncing existing secrets to Windmill...");
    const wmToken = getWindmillToken();
    const wmBase = "http://127.0.0.1:8000/api/w/imladris";
    const wmFolder = domain === "work" ? "domains/work/infra" : domain;

    for (const field of existingFields) {
      const secretKey = `${providerSlug}-${field.replace(/_/g, "-")}`;
      const value = await getSecretValue(secretMgr, secretKey);
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

// ── Multi-backend secret manager helpers ──

async function checkExistingSecrets(mgr: string, providerSlug: string, fields: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  const allKeys = await listSecretKeys(mgr);

  for (const field of fields) {
    const key = `${providerSlug}-${field.replace(/_/g, "-")}`;
    if (allKeys.has(key)) { existing.add(key); continue; }

    // Check legacy naming patterns
    for (const prefix of ["api-", "investigate-", "devops-"]) {
      if (allKeys.has(`${prefix}${key}`)) { existing.add(`${prefix}${key}`); break; }
    }
  }
  return existing;
}

async function listSecretKeys(mgr: string): Promise<Set<string>> {
  try {
    switch (mgr) {
      case "bws": {
        const proc = Bun.spawn(["bws", "secret", "list"], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        const secrets: Array<{ key: string }> = JSON.parse(output);
        return new Set(secrets.map(s => s.key));
      }
      case "aws_sm": {
        const proc = Bun.spawn(["aws", "secretsmanager", "list-secrets", "--output", "json"], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        const result = JSON.parse(output);
        return new Set((result.SecretList || []).map((s: any) => s.Name));
      }
      case "ssm": {
        const proc = Bun.spawn(["aws", "ssm", "describe-parameters", "--output", "json"], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        const result = JSON.parse(output);
        return new Set((result.Parameters || []).map((p: any) => p.Name.replace(/^\/imladris\//, "")));
      }
      case "hashicorp": {
        const proc = Bun.spawn(["vault", "kv", "list", "-format=json", "secret/imladris/"], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        return new Set(JSON.parse(output));
      }
      case "1password": {
        const proc = Bun.spawn(["op", "item", "list", "--format=json", "--vault=imladris"], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        const items: Array<{ title: string }> = JSON.parse(output);
        return new Set(items.map(i => i.title));
      }
      default:
        return new Set();
    }
  } catch {
    return new Set();
  }
}

async function storeSecret(mgr: string, key: string, value: string, note: string): Promise<boolean> {
  try {
    switch (mgr) {
      case "bws": {
        const proc = Bun.spawn(["bws", "secret", "create", key, value, "--note", note], { stdout: "pipe", stderr: "pipe" });
        return (await proc.exited) === 0;
      }
      case "aws_sm": {
        const proc = Bun.spawn(["aws", "secretsmanager", "create-secret", "--name", `imladris/${key}`, "--secret-string", value, "--description", note], { stdout: "pipe", stderr: "pipe" });
        return (await proc.exited) === 0;
      }
      case "ssm": {
        const proc = Bun.spawn(["aws", "ssm", "put-parameter", "--name", `/imladris/${key}`, "--value", value, "--type", "SecureString", "--description", note, "--overwrite"], { stdout: "pipe", stderr: "pipe" });
        return (await proc.exited) === 0;
      }
      case "hashicorp": {
        const proc = Bun.spawn(["vault", "kv", "put", `secret/imladris/${key}`, `value=${value}`], { stdout: "pipe", stderr: "pipe" });
        return (await proc.exited) === 0;
      }
      case "1password": {
        const proc = Bun.spawn(["op", "item", "create", "--category=password", `--title=${key}`, `--vault=imladris`, `password=${value}`, `--tags=${note}`], { stdout: "pipe", stderr: "pipe" });
        return (await proc.exited) === 0;
      }
      case "windmill_only":
        return true; // stored in Windmill only (done in the main flow)
      default:
        return false;
    }
  } catch {
    return false;
  }
}

async function getSecretValue(mgr: string, key: string): Promise<string | null> {
  try {
    switch (mgr) {
      case "bws": {
        const proc = Bun.spawn(["bws", "secret", "list"], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        const secrets: Array<{ key: string; value: string }> = JSON.parse(output);
        return secrets.find(s => s.key === key)?.value || null;
      }
      case "aws_sm": {
        const proc = Bun.spawn(["aws", "secretsmanager", "get-secret-value", "--secret-id", `imladris/${key}`, "--output", "json"], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        return JSON.parse(output).SecretString || null;
      }
      case "ssm": {
        const proc = Bun.spawn(["aws", "ssm", "get-parameter", "--name", `/imladris/${key}`, "--with-decryption", "--output", "json"], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        return JSON.parse(output).Parameter?.Value || null;
      }
      case "hashicorp": {
        const proc = Bun.spawn(["vault", "kv", "get", "-format=json", `secret/imladris/${key}`], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        return JSON.parse(output).data?.data?.value || null;
      }
      case "1password": {
        const proc = Bun.spawn(["op", "item", "get", key, "--vault=imladris", "--fields=password"], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        return output.trim() || null;
      }
      default:
        return null;
    }
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
