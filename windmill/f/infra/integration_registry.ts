// integration_registry.ts — Central registry of all authenticated data sources
//
// Lists every integration, its auth method, domain, health status, and
// credential location. Used by the status dashboard to show what's connected.
//
// To add a new integration:
// 1. Add an entry to INTEGRATIONS below
// 2. Store credentials in BWS (source of truth)
// 3. Run sync-credentials.sh to push to Windmill
// 4. Write the Windmill script in the appropriate domain directory

interface Integration {
  name: string;
  domain: "work" | "personal" | "shared" | "infra";
  auth_type: "api_key" | "oauth2" | "oauth2_client_credentials" | "basic" | "bearer" | "saml_sso" | "none";
  auth_provider?: string;  // "grant" | "windmill_native" | "custom" | "bws_direct"
  bws_keys: string[];      // BWS secret key names for this integration
  windmill_vars: string[];  // Windmill variable paths
  health_check?: string;   // Windmill script path for health check
  status: "active" | "configured" | "placeholder" | "deprecated";
  notes?: string;
}

const INTEGRATIONS: Integration[] = [
  // ── Work Domain: Cloud & Infrastructure ──
  {
    name: "AWS (16 accounts)",
    domain: "work",
    auth_type: "bearer",
    auth_provider: "bws_direct",
    bws_keys: ["aws-cross-accounts"],
    windmill_vars: [],
    health_check: "f/infra/status_check",
    status: "active",
    notes: "Instance role + cross-account AssumeRole via ImladrisReadOnly",
  },
  {
    name: "Azure AD / Entra ID",
    domain: "work",
    auth_type: "oauth2_client_credentials",
    auth_provider: "custom",
    bws_keys: ["devops-m365-tenant-id", "devops-m365-client-id", "devops-m365-client-secret"],
    windmill_vars: ["f/devops/m365_tenant_id", "f/devops/m365_client_id", "f/devops/m365_client_secret"],
    health_check: "f/infra/status_check",
    status: "active",
  },
  {
    name: "M365 Graph API (Email)",
    domain: "work",
    auth_type: "oauth2_client_credentials",
    auth_provider: "custom",
    bws_keys: ["devops-m365-tenant-id", "devops-m365-client-id", "devops-m365-client-secret"],
    windmill_vars: ["f/devops/m365_tenant_id", "f/devops/m365_client_id", "f/devops/m365_client_secret"],
    status: "active",
    notes: "Shared credentials with Azure AD",
  },
  {
    name: "SDP (ManageEngine ServiceDesk Plus Cloud)",
    domain: "work",
    auth_type: "oauth2",
    auth_provider: "custom",
    bws_keys: ["devops-sdp-base-url", "devops-sdp-api-key"],
    windmill_vars: ["f/devops/sdp_base_url", "f/devops/sdp_api_key"],
    health_check: "f/infra/status_check",
    status: "active",
    notes: "Zoho OAuth token refreshed every 45 min by refresh_sdp_token schedule",
  },
  {
    name: "Site24x7",
    domain: "work",
    auth_type: "oauth2",
    auth_provider: "custom",
    bws_keys: ["site24x7-client-id", "site24x7-client-secret", "site24x7-refresh-token"],
    windmill_vars: ["f/investigate/site24x7_access_token"],
    health_check: "f/infra/status_check",
    status: "active",
    notes: "Zoho OAuth, access token refreshed every 45 min",
  },
  {
    name: "Aikido Security",
    domain: "work",
    auth_type: "oauth2_client_credentials",
    auth_provider: "custom",
    bws_keys: ["investigate-aikido-client-id", "investigate-aikido-client-secret"],
    windmill_vars: ["f/investigate/aikido_client_id", "f/investigate/aikido_client_secret"],
    status: "active",
    notes: "EU region (app.aikido.dev)",
  },
  {
    name: "Securonix SNYPR",
    domain: "work",
    auth_type: "basic",
    auth_provider: "bws_direct",
    bws_keys: ["buxton/a5t7igtf-securonix-net-securonix-local-user"],
    windmill_vars: [],
    health_check: "f/infra/status_check",
    status: "active",
  },
  {
    name: "Azure DevOps",
    domain: "work",
    auth_type: "bearer",
    auth_provider: "bws_direct",
    bws_keys: ["svc-aikido-devops-pat"],
    windmill_vars: [],
    status: "active",
    notes: "PAT with Code scope, no Pipeline scope",
  },
  {
    name: "Slack",
    domain: "shared",
    auth_type: "bearer",
    auth_provider: "bws_direct",
    bws_keys: ["devops-slack-bot-token"],
    windmill_vars: [],
    status: "active",
  },
  {
    name: "Telegram",
    domain: "shared",
    auth_type: "api_key",
    auth_provider: "bws_direct",
    bws_keys: ["investigate-telegram-session"],
    windmill_vars: [],
    status: "active",
  },
  {
    name: "Steampipe",
    domain: "infra",
    auth_type: "none",
    bws_keys: [],
    windmill_vars: [],
    health_check: "f/infra/status_check",
    status: "active",
    notes: "Local Docker container, no auth needed (172.17.0.1:9193)",
  },
  {
    name: "SigNoz (POC)",
    domain: "work",
    auth_type: "api_key",
    auth_provider: "bws_direct",
    bws_keys: ["api-signoz-poc-admin", "signoz-ingestion-key"],
    windmill_vars: [],
    status: "configured",
    notes: "rare-weevil.us.signoz.cloud — POC, PJT-122",
  },
  {
    name: "ConductorOne",
    domain: "work",
    auth_type: "oauth2_client_credentials",
    auth_provider: "bws_direct",
    bws_keys: ["api-conductorone-client-id", "api-conductorone-client-secret"],
    windmill_vars: [],
    status: "configured",
    notes: "Identity governance — credentials exist, integration not built yet",
  },
  {
    name: "Okta",
    domain: "work",
    auth_type: "api_key",
    auth_provider: "bws_direct",
    bws_keys: ["investigate-okta-api-token", "investigate-okta-org-url"],
    windmill_vars: ["f/investigate/okta_api_token", "f/investigate/okta_org_url"],
    status: "placeholder",
    notes: "Placeholder — token not yet provisioned",
  },
  // ── Infra: AI & Tooling ──
  {
    name: "AWS Bedrock (Claude/Titan)",
    domain: "infra",
    auth_type: "bearer",
    auth_provider: "bws_direct",
    bws_keys: [],
    windmill_vars: [],
    status: "active",
    notes: "Uses instance IAM role — no stored credentials",
  },
  {
    name: "ElevenLabs (Voice)",
    domain: "infra",
    auth_type: "api_key",
    auth_provider: "bws_direct",
    bws_keys: ["api-elevenlabs"],
    windmill_vars: [],
    status: "active",
  },
  {
    name: "Apify",
    domain: "shared",
    auth_type: "api_key",
    auth_provider: "bws_direct",
    bws_keys: ["apify-api-token"],
    windmill_vars: [],
    status: "configured",
  },
  {
    name: "Bright Data",
    domain: "shared",
    auth_type: "api_key",
    auth_provider: "bws_direct",
    bws_keys: ["bright-data-api-key", "bright-data-proxy-url"],
    windmill_vars: [],
    status: "configured",
  },
];

export async function main(
  action: string = "list",
  domain_filter: string = "",
  status_filter: string = "",
) {
  let filtered = INTEGRATIONS;

  if (domain_filter) {
    filtered = filtered.filter(i => i.domain === domain_filter);
  }
  if (status_filter) {
    filtered = filtered.filter(i => i.status === status_filter);
  }

  if (action === "list") {
    return {
      integrations: filtered.map(i => ({
        name: i.name,
        domain: i.domain,
        auth_type: i.auth_type,
        status: i.status,
        bws_key_count: i.bws_keys.length,
        notes: i.notes,
      })),
      summary: {
        total: filtered.length,
        active: filtered.filter(i => i.status === "active").length,
        configured: filtered.filter(i => i.status === "configured").length,
        placeholder: filtered.filter(i => i.status === "placeholder").length,
        by_domain: {
          work: filtered.filter(i => i.domain === "work").length,
          personal: filtered.filter(i => i.domain === "personal").length,
          shared: filtered.filter(i => i.domain === "shared").length,
          infra: filtered.filter(i => i.domain === "infra").length,
        },
        by_auth: {
          oauth2: filtered.filter(i => i.auth_type.startsWith("oauth2")).length,
          api_key: filtered.filter(i => i.auth_type === "api_key").length,
          bearer: filtered.filter(i => i.auth_type === "bearer").length,
          basic: filtered.filter(i => i.auth_type === "basic").length,
          none: filtered.filter(i => i.auth_type === "none").length,
        },
      },
    };
  }

  if (action === "detail") {
    return { integrations: filtered };
  }

  return { error: `Unknown action: ${action}. Use 'list' or 'detail'.` };
}
