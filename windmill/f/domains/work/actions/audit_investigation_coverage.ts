// Windmill Script: Audit Investigation Tool Coverage
// Daily check: do all API credential sources in Windmill have investigation tools?
// Compares Windmill variables (synced from BWS) against deployed f/investigate/ scripts.
// Reports gaps to Slack.

const WM_BASE = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
const WM_TOKEN = process.env.WM_TOKEN;
const WM_WORKSPACE = process.env.WM_WORKSPACE || "imladris";

async function wmFetch(path: string): Promise<any> {
  const resp = await fetch(`${WM_BASE}/api/w/${WM_WORKSPACE}${path}`, {
    headers: { Authorization: `Bearer ${WM_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`WM API ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function getVariable(path: string): Promise<string | undefined> {
  try {
    const resp = await fetch(
      `${WM_BASE}/api/w/${WM_WORKSPACE}/variables/get_value/${path}`,
      { headers: { Authorization: `Bearer ${WM_TOKEN}` } },
    );
    if (!resp.ok) return undefined;
    const val = await resp.text();
    return (val.startsWith('"') ? JSON.parse(val) : val).trim();
  } catch { return undefined; }
}

// ── Source mapping ──
// Maps Windmill variable prefixes to canonical source names.
// Variables not matching any prefix are flagged for review.

const SOURCE_MAP: Record<string, string> = {
  aikido: "aikido",
  aws_account: "aws",
  aws_cross: "aws",
  azuredevops: "azuredevops",
  cloudflare: "cloudflare",
  gcp: "gcp",
  github: "github",
  m365: "m365",
  okta: "okta",
  sdp: "sdp",
  securonix: "securonix",
  signoz: "signoz",
  site24x7: "site24x7",
  slack: "slack",
  sophos: "sophos",
  tailscale: "tailscale",
  telegram: "telegram",
};

// Variables that are NOT API credential sources — skip in audit
const SKIP_PREFIXES = [
  "api_elevenlabs",    // voice tool, not investigation
  "apify",             // scraping tool
  "bright_data",       // scraping proxy, not investigation
  "buxton_sf",         // personal creds
  "luks",              // encryption key
  "p81",               // perimeter 81, deprecated
  "rclone",            // storage sync
  "safebase",          // compliance portal
  "sessions_git",      // git session
  "signal",            // messaging
  "steampipe",         // internal tool
  "telegram_triage",   // state tracking, not credential
  "slack_approval",    // config, not credential
];

function extractSource(varPath: string): string | null {
  // Strip folder prefix: f/devops/foo_bar → foo_bar, f/investigate/foo_bar → foo_bar
  const name = varPath.replace(/^f\/(devops|investigate)\//, "");

  // Check skip list
  for (const skip of SKIP_PREFIXES) {
    if (name.startsWith(skip)) return null;
  }

  // Match against source map (longest prefix first)
  const sortedPrefixes = Object.keys(SOURCE_MAP).sort((a, b) => b.length - a.length);
  for (const prefix of sortedPrefixes) {
    if (name.startsWith(prefix)) return SOURCE_MAP[prefix];
  }

  return `unknown:${name}`;
}

export async function main(): Promise<{
  total_sources: number;
  covered: string[];
  gaps: string[];
  unknown_variables: string[];
  report: string;
}> {
  // Step 1: List all Windmill variables
  const vars: any[] = await wmFetch("/variables/list?per_page=200");
  const relevantVars = vars.filter(
    (v: any) =>
      v.path.startsWith("f/devops/") || v.path.startsWith("f/investigate/")
  );

  // Step 2: Extract unique sources
  const sources = new Set<string>();
  const unknowns: string[] = [];

  for (const v of relevantVars) {
    const source = extractSource(v.path);
    if (source === null) continue; // skipped
    if (source.startsWith("unknown:")) {
      unknowns.push(v.path);
    } else {
      sources.add(source);
    }
  }

  // Step 3: List all f/investigate/ scripts
  const scripts: any[] = await wmFetch("/scripts/list?per_page=200");
  const investigateScripts = scripts
    .filter((s: any) => s.path.startsWith("f/investigate/"))
    .map((s: any) => s.path.replace("f/investigate/", ""));

  // Step 4: Check coverage — does each source have at least one investigate script?
  const covered: string[] = [];
  const gaps: string[] = [];

  for (const source of Array.from(sources).sort()) {
    const hasScripts = investigateScripts.some(
      (s: string) => s.startsWith(source) || s.includes(source)
    );

    // Special cases: m365 → azure/identity, sdp → sdp, site24x7 → monitoring
    const specialMappings: Record<string, string[]> = {
      m365: ["get_azure", "get_identity"],
      site24x7: ["get_monitoring"],
      securonix: ["get_security_events"],
    };

    const hasSpecial = specialMappings[source]?.some((prefix) =>
      investigateScripts.some((s: string) => s.startsWith(prefix))
    );

    if (hasScripts || hasSpecial) {
      covered.push(source);
    } else {
      gaps.push(source);
    }
  }

  // Step 5: Build report
  const lines: string[] = [
    `*Investigation Tool Coverage Audit*`,
    `_${new Date().toISOString().slice(0, 10)}_`,
    ``,
    `*Sources:* ${sources.size} total | ${covered.length} covered | ${gaps.length} gaps`,
  ];

  if (gaps.length > 0) {
    lines.push(``);
    lines.push(`*Gaps (no investigation tools):*`);
    for (const g of gaps) {
      lines.push(`  - \`${g}\``);
    }
  }

  if (unknowns.length > 0) {
    lines.push(``);
    lines.push(`*Unmapped variables (review):*`);
    for (const u of unknowns.slice(0, 10)) {
      lines.push(`  - \`${u}\``);
    }
    if (unknowns.length > 10) {
      lines.push(`  _...and ${unknowns.length - 10} more_`);
    }
  }

  if (gaps.length === 0 && unknowns.length === 0) {
    lines.push(``);
    lines.push(`All credential sources have investigation tools.`);
  }

  const report = lines.join("\n");

  // Step 6: Post to Slack if gaps found
  if (gaps.length > 0 || unknowns.length > 0) {
    const slackToken = await getVariable("f/devops/slack_user_token");
    if (slackToken) {
      const approvalChannel = await getVariable("f/devops/slack_approval_channel");
      const channel = approvalChannel || "imladris";
      try {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${slackToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel,
            text: `Investigation coverage audit: ${gaps.length} gaps found`,
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: report },
              },
            ],
          }),
        });
      } catch (e) {
        console.warn(`Slack post failed: ${e}`);
      }
    }
  }

  console.log(report);

  return {
    total_sources: sources.size,
    covered,
    gaps,
    unknown_variables: unknowns,
    report,
  };
}
