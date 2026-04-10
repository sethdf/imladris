// Windmill Script: Agentic Investigator (System 2)
// Bedrock Converse API tool-use loop — Opus investigates alerts autonomously.
//
// Architecture:
//   - Runs the PAI Algorithm adapted for autonomous operation
//   - Algorithm loaded at runtime from ~/.claude/PAI/Algorithm/ (auto-updates with PAI)
//   - Phases: OBSERVE → THINK → INVESTIGATE → VERIFY → SUBMIT
//   - 20 investigation tools from f/investigate/ executed via Windmill HTTP API
//   - Max 8 rounds, nudge at round 6, parallel tool execution
//   - Evidence chain + differential diagnosis validation before acceptance
//   - Cost: ~$0.85/investigation at 5/day
//
// Integration:
//   Called by process_actionable.ts via async Windmill job submission.

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
  type SystemContentBlock,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import * as cacheLib from "./cache_lib.ts";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// ── Constants ──

const MODEL_ID = "us.anthropic.claude-opus-4-6-v1";
const MAX_ROUNDS = 8;
const NUDGE_AT = 6;
const TOOL_TIMEOUT_MS = 60_000;
const MAX_TOOL_RESULT_BYTES = 50_000;
const WM_BASE = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
const WM_TOKEN = process.env.WM_TOKEN;
const WM_WORKSPACE = process.env.WM_WORKSPACE || "imladris";
const ALGORITHM_DIR = "/home/ec2-user/.claude/PAI/Algorithm";

// ── Algorithm Loading ──

/**
 * Read the PAI Algorithm at runtime, strip human-interaction elements,
 * and adapt for autonomous investigation. When PAI updates upstream,
 * the investigator automatically adopts the new Algorithm version.
 */
function loadAlgorithmPrinciples(): string {
  try {
    // Read LATEST pointer to find current Algorithm version
    const latestVersion = readFileSync(join(ALGORITHM_DIR, "LATEST"), "utf-8").trim();
    const algorithmPath = join(ALGORITHM_DIR, `${latestVersion}.md`);
    const raw = readFileSync(algorithmPath, "utf-8");

    // Strip human-interaction elements while preserving cognitive structure
    const cleaned = raw
      // Remove voice curl blocks
      .replace(/\*\*Voice:\*\*.*?```\n/gs, "")
      .replace(/```bash\ncurl -s -X POST http:\/\/localhost:8888\/notify[\s\S]*?```\n/g, "")
      // Remove PRD file writing instructions
      .replace(/\*\*WRITE TO PRD.*?\n/g, "")
      .replace(/- Create PRD directory:.*?\n/g, "")
      .replace(/- Write PRD\.md with Write tool.*?\n/g, "")
      .replace(/Edit PRD frontmatter.*?\.\s*/g, "")
      // Remove console output format blocks
      .replace(/\*\*Console output.*?```\n[\s\S]*?```\n/g, "")
      // Remove capability selection from skills (investigator has fixed tools)
      .replace(/CAPABILITY SELECTION \(CRITICAL, MANDATORY\):[\s\S]*?EXAMPLES:/g, "TOOL SELECTION:\nSelect which of your available investigation tools are relevant for this alert.\n\nEXAMPLES:")
      // Remove effort level table (investigator has fixed effort)
      .replace(/### Effort Levels[\s\S]*?\n\n/g, "")
      // Remove ISC count gate (investigator criteria are alert-driven)
      .replace(/\*\*ISC COUNT GATE[\s\S]*?No exceptions\.\n/g, "")
      // Remove EnterPlanMode references
      .replace(/EnterPlanMode.*?\.\s*/g, "")
      // Remove context recovery section (investigator has no prior context)
      .replace(/### Context Recovery[\s\S]*?### PRD\.md Format/g, "### PRD.md Format")
      // Remove PRD format section
      .replace(/### PRD\.md Format[\s\S]*?---\n/g, "")
      // Remove phantom capabilities rule (not applicable)
      .replace(/- No phantom capabilities.*?\n/g, "")
      // Remove context compaction rule (Bedrock manages context)
      .replace(/- \*\*Context compaction at phase transitions\*\*[\s\S]*?late-phase failures in long Algorithm runs\.\n/g, "")
      // Clean up multiple blank lines
      .replace(/\n{3,}/g, "\n\n");

    console.log(`[agentic_investigator] Loaded Algorithm ${latestVersion} (${cleaned.length} chars after adaptation)`);
    return cleaned;
  } catch (err: any) {
    console.warn(`[agentic_investigator] Could not load Algorithm: ${err.message}. Using embedded fallback.`);
    return "";
  }
}

// ── System Prompt ──

const AUTONOMOUS_ADAPTER = `You are an autonomous DevOps/SecOps investigator for BuxtonIT, running the PAI Algorithm adapted for fully autonomous operation. You receive alerts from email, Slack, and monitoring systems and must investigate them without human interaction.

AUTONOMOUS ADAPTATION:
You execute the PAI Algorithm's cognitive phases within your available rounds. Every phase is mandatory — do not skip phases or submit a diagnosis without completing THINK and VERIFY.

━━━ OBSERVE (Round 1) ━━━
- Classify: What domain is this alert? (AWS, Azure, Network, Security, Application, Identity)
- Load knowledge: Call load_domain_knowledge with the alert text to get domain-specific investigation runbooks. Use these runbooks to guide your investigation strategy.
- Decompose: Write ISC criteria — specific questions this alert requires you to answer. Each criterion must be ATOMIC (one verifiable thing, binary testable).
- Plan: Which of your available tools are relevant for this specific alert?

━━━ THINK (Round 1-2) ━━━
- Premortem: How could this investigation reach the WRONG conclusion? What are the riskiest assumptions?
- Hypothesize: Generate 2-3 alternative explanations for the observed symptoms BEFORE investigating. Do not anchor on the first plausible explanation.
- Distinguish: What specific evidence would differentiate between hypotheses? Plan your tool calls to test ALL hypotheses, not just the leading one.

━━━ INVESTIGATE (Rounds 2-6) ━━━
- Execute tool calls in parallel when independent.
- Gather evidence for AND against ALL hypotheses, not just the leading one.
- Track each criterion: "verified" (with specific tool evidence) or "needs_data_source" (flag via request_data_source).
- If a tool returns unexpected results, investigate further — do not explain away anomalies.
- If you realize you need a data source that doesn't exist, call request_data_source immediately, then continue with available tools.

━━━ VERIFY (Rounds 6-7) ━━━
- Differential elimination: For each alternative hypothesis, cite specific evidence that contradicts it. If you cannot eliminate an alternative, that IS genuine uncertainty — state it.
- Evidence chain audit: Every claim in your diagnosis must trace to a specific tool call (tool name, raw value, resource ID). No inference without evidence.
- Adversarial self-challenge: "What would disprove this diagnosis? What haven't I checked?"
- If verification reveals gaps, use remaining rounds to fill them.
- QUALITY CHECK: Call check_investigation_quality to see how past investigations of similar alerts were rated. If similar alerts had common misdiagnosis patterns, verify you haven't made the same mistakes.

━━━ REMEDIATION PROPOSAL (Round 7) ━━━
- Before submitting, assess whether automated remediation is appropriate.
- PAST OUTCOMES: Call check_remediation_outcomes to see what has worked (or failed) for similar alert types and domains. Learn from past results before proposing.
- You can propose ANY remediation — there are no fixed playbooks. Think about what action would actually fix the root cause.
- Two action types:
  * automated: System executes shell commands after human approval. Commands MUST be aws or az CLI commands only.
  * manual: Human action items that cannot be automated (e.g., "contact vendor", "review IAM policy with team"). Tracked as acknowledged.
- For EVERY proposal, include remediation_proposal in submit_diagnosis with:
  * description: Clear, specific description of what the remediation does and why
  * action_type: "automated" or "manual"
  * target_resource: The specific resource ID from your investigation evidence
  * commands: Array of shell commands to execute (automated only, must be aws/az CLI)
  * rollback_commands: Array of commands to reverse the action (automated only)
  * blast_radius: What else could be affected — be specific about dependent services, users, or systems
  * remediation_confidence: How confident that this fixes the root cause
  * reasoning: Evidence-based reasoning for this specific approach
- If NO remediation is appropriate, omit remediation_proposal entirely.
- NEVER propose remediation for informational/low-severity findings.

━━━ SUBMIT (Round 7-8) ━━━
- Call submit_diagnosis with structured evidence chains, differentials, and remediation_proposal (if applicable).
- Before proposing remediation, call check_remediation_outcomes to learn from past results.
- Confidence must reflect verification completeness, not gut feel.
- Include self-reflection: what would you investigate differently next time?

CRITERION RULES:
- Only two valid statuses: "verified" and "needs_data_source"
- "verified": answered with specific evidence from a tool result
- "needs_data_source": no available tool provides the data. Specify what system/data is needed.
- There is NO "unresolvable" status. If a human could figure it out, you need a data source.

EVIDENCE CHAIN RULES:
- Every claim must cite: tool_used, raw_value, resource_id
- No inference without evidence. If you didn't see it in tool output, don't assert it.

CONFIDENCE RULES:
- "high": strong evidence, alternatives eliminated, evidence chain complete
- "medium": partial evidence or alternatives not fully eliminated. Rejected in early rounds.
- "low": speculative. Almost never accepted.

ENVIRONMENT:
- AWS: 16 accounts in BuxtonIT org (767448074758 is imladris/local). All accessible via tools.
- Azure AD: Microsoft 365 tenant with user, device, and sign-in data.
- SDP: ServiceDesk Plus for ticket management.
- Securonix: SIEM for security incidents and violations.
- Site24x7: Infrastructure monitoring.
- Slack: Team communication channels and threads.
- Local cache: SQLite triage cache with alert history and resource inventory.

RULES:
- All tools are READ-ONLY. You cannot modify any resource.
- If a tool returns an error about missing credentials, call request_data_source with the tool name and "credentials not configured" as the reason.
- Keep tool calls focused — use filters and limits to avoid pulling excessive data.`;

function buildSystemPrompt(): string {
  const algorithmPrinciples = loadAlgorithmPrinciples();

  if (algorithmPrinciples) {
    return `${AUTONOMOUS_ADAPTER}

━━━ PAI ALGORITHM REFERENCE (auto-loaded, version updates automatically) ━━━
The following is the PAI Algorithm that governs your cognitive process. The AUTONOMOUS ADAPTATION section above tells you how to run each phase without human interaction. The Algorithm below provides the methodology — ISC decomposition, splitting test, verification rigor, and learning patterns.

${algorithmPrinciples}`;
  }

  // Fallback if Algorithm file isn't accessible
  return AUTONOMOUS_ADAPTER;
}

const SYSTEM_PROMPT = buildSystemPrompt();

// ── PAI Context Preamble (memory-sync Phase 4c) ──
//
// Before each investigation, query Postgres core.assemble_context() to get
// PAI's institutional knowledge relevant to the current alert — recent
// learnings, failure patterns, and domain wisdom. Prepend it to the system
// prompt so Opus starts each investigation with the accumulated lessons
// from every prior run.
//
// Fails open: if Postgres is unreachable, the function returns empty string
// and the investigator runs with only the base system prompt (current behavior).

async function fetchPAIContext(taskDescription: string): Promise<string> {
  const dbUrlRaw = process.env.DATABASE_URL;
  if (!dbUrlRaw) return "";

  try {
    const { Client } = (await import("pg")) as any;
    const dbUrl = new URL(dbUrlRaw);
    dbUrl.pathname = "/pai";
    const client = new Client({ connectionString: dbUrl.toString(), statement_timeout: 5000 });
    await client.connect();
    try {
      const res = await client.query(
        "SELECT core.assemble_context($1, $2) AS ctx",
        [taskDescription.slice(0, 2000), "standard"],
      );
      const ctx = res.rows?.[0]?.ctx;
      if (!ctx) return "";
      const methodology = ctx.methodology || "";
      const memory = ctx.relevant_memory || ctx.memory || "";
      const stats = ctx.stats ? JSON.stringify(ctx.stats) : "";
      const parts: string[] = [];
      if (methodology) parts.push(`METHODOLOGY:\n${methodology}`);
      if (memory) parts.push(`RELEVANT PAI MEMORY:\n${typeof memory === "string" ? memory : JSON.stringify(memory)}`);
      if (stats) parts.push(`MEMORY STATS: ${stats}`);
      return parts.length
        ? `\n\n━━━ PAI INSTITUTIONAL CONTEXT (from core.assemble_context) ━━━\n${parts.join("\n\n")}\n`
        : "";
    } finally {
      await client.end().catch(() => {});
    }
  } catch (err) {
    console.warn(`[PAI context] fetch failed, continuing without: ${(err as Error).message}`);
    return "";
  }
}

// ── Tool Definitions ──

const TOOLS: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "check_network",
        description: "DNS lookups, reverse DNS, TLS certificate checks, MX and TXT record lookups. Use for investigating domain ownership, IP attribution, and certificate validity.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["dns_lookup", "reverse_dns", "check_certificate", "mx_lookup", "txt_lookup"], description: "Type of network check" },
              target: { type: "string", description: "Hostname or IP address to check" },
            },
            required: ["action", "target"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_aws_resources",
        description: "Query RDS, Lambda, S3, or ECS resources across AWS accounts. Use to find specific resources or get an overview of a service.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              resource_type: { type: "string", enum: ["rds", "lambda", "s3", "ecs"], description: "AWS resource type to query" },
              account: { type: "string", description: "Account name or 'all' (default: all)" },
              name_contains: { type: "string", description: "Filter by name substring" },
              limit: { type: "number", description: "Max results (default: 100)" },
            },
            required: ["resource_type"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_azure_devices",
        description: "Query Azure AD devices — compliance status, OS info, ownership. Use to investigate device-related alerts.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              display_name_contains: { type: "string", description: "Filter by device display name" },
              os_type: { type: "string", description: "Filter by OS type" },
              is_compliant: { type: "boolean", description: "Filter by compliance status" },
              limit: { type: "number", description: "Max results (default: 50)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_azure_sign_ins",
        description: "Query Azure AD sign-in logs for a specific user. REQUIRES user_email. Use to investigate suspicious login activity.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              user_email: { type: "string", description: "User email address (required)" },
              hours_back: { type: "number", description: "How many hours back to search (default: 24)" },
              status_filter: { type: "string", enum: ["success", "failure", "interrupted"], description: "Filter by sign-in status" },
              limit: { type: "number", description: "Max results (default: 50)" },
            },
            required: ["user_email"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_azure_users",
        description: "Query Azure AD users — email, department, name, enabled status. Use to identify who a user is and their organizational context.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              email: { type: "string", description: "Filter by email" },
              department: { type: "string", description: "Filter by department" },
              name_contains: { type: "string", description: "Filter by name substring" },
              enabled_only: { type: "boolean", description: "Only enabled accounts (default: true)" },
              limit: { type: "number", description: "Max results (default: 50)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_cloudwatch_alarms",
        description: "List CloudWatch alarms across AWS accounts. Filter by state (ALARM, OK, INSUFFICIENT_DATA) or alarm name.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              account: { type: "string", description: "Account name or 'all' (default: all)" },
              state: { type: "string", enum: ["ALARM", "OK", "INSUFFICIENT_DATA"], description: "Filter by alarm state" },
              alarm_name_contains: { type: "string", description: "Filter by alarm name substring" },
              limit: { type: "number", description: "Max results (default: 100)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_ec2_instances",
        description: "List EC2 instances across AWS accounts. Filter by state, instance ID, name, IP, or VPC.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              account: { type: "string", description: "Account name or 'all' (default: all)" },
              state: { type: "string", enum: ["running", "stopped", "terminated", "pending", "shutting-down"], description: "Filter by instance state" },
              instance_id: { type: "string", description: "Filter by instance ID" },
              name_contains: { type: "string", description: "Filter by name substring" },
              private_ip: { type: "string", description: "Filter by private IP" },
              vpc_id: { type: "string", description: "Filter by VPC ID" },
              limit: { type: "number", description: "Max results (default: 100)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_identity_info",
        description: "Query Okta for user details — profile, MFA factors, app assignments, auth events. REQUIRES email.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              email: { type: "string", description: "User email address (required)" },
              include: { type: "string", description: "Comma-separated sections: profile, mfa_factors, apps, events (default: profile,mfa_factors)" },
            },
            required: ["email"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_monitoring_alerts",
        description: "Query Site24x7 for monitor status and active alarms. Use to check infrastructure health.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["current_status", "alarms", "monitors"], description: "What to query (default: current_status)" },
              monitor_name: { type: "string", description: "Filter by monitor name" },
              status_filter: { type: "string", enum: ["DOWN", "TROUBLE", "UP", "CRITICAL"], description: "Filter by status" },
              limit: { type: "number", description: "Max results (default: 50)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_sdp_tickets",
        description: "Read-only SDP ticket lookup. Search by ID, text, status, requester, or technician.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              ticket_id: { type: "string", description: "Look up specific ticket by ID" },
              search: { type: "string", description: "Search ticket text" },
              status: { type: "string", enum: ["Open", "In Progress", "On Hold", "Resolved", "Closed"], description: "Filter by status" },
              requester: { type: "string", description: "Filter by requester name" },
              technician: { type: "string", description: "Filter by technician name" },
              limit: { type: "number", description: "Max results (default: 20)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_security_events",
        description: "Query Securonix SIEM — incidents, violations, and threat activity. Use for security-related investigations.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["incidents", "incident", "violations", "threats"], description: "What to query (default: incidents)" },
              query: { type: "string", description: "Incident ID (for 'incident' action) or search query" },
              max: { type: "number", description: "Max results (default: 25)" },
              days: { type: "number", description: "How many days back to search (default: 90)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_security_groups",
        description: "List VPC security groups and their rules across AWS accounts. Use to investigate open ports, overly permissive rules, or VPC topology.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              account: { type: "string", description: "Account name or 'all' (default: all)" },
              vpc_id: { type: "string", description: "Filter by VPC ID" },
              group_id: { type: "string", description: "Filter by security group ID" },
              group_name_contains: { type: "string", description: "Filter by group name substring" },
              include_rules: { type: "boolean", description: "Include inbound/outbound rules (default: true)" },
              limit: { type: "number", description: "Max results (default: 50)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "query_resources",
        description: "Search the AWS resource inventory (auto-discovered). Find resources by name, type, account, or region.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["search", "list", "stats"], description: "Query type (default: search)" },
              query: { type: "string", description: "Search term (required for search action)" },
              resource_type: { type: "string", description: "Filter by resource type" },
              limit: { type: "number", description: "Max results (default: 20)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "query_vendors",
        description: "Search the vendor inventory (~280 vendors). Find vendors by name, criticality, or login status.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["search", "list", "stats"], description: "Query type (default: search)" },
              query: { type: "string", description: "Search term (required for search action)" },
              criticality: { type: "string", enum: ["High", "Med", "Low"], description: "Filter by criticality" },
              has_login: { type: "boolean", description: "Filter to vendors with login portals" },
              limit: { type: "number", description: "Max results (default: 20)" },
              offset: { type: "number", description: "Pagination offset (default: 0)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "search_alert_history",
        description: "Search the triage cache — past alerts by entity ID, text search, recent items, or pipeline stats.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["entity", "search", "recent", "stats"], description: "Query type (default: search)" },
              query: { type: "string", description: "Entity ID or search term" },
              source: { type: "string", enum: ["m365", "slack", "sdp"], description: "Filter by alert source" },
              hours_back: { type: "number", description: "How far back to search in hours (default: 168)" },
              limit: { type: "number", description: "Max results (default: 20)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "triage_overview",
        description: "Pipeline statistics and recent actionable items. Use to understand the current alert landscape.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["stats", "actionable", "investigated", "stale"], description: "What to show (default: stats)" },
              limit: { type: "number", description: "Max results (default: 20)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_cloudtrail_events",
        description: "Query CloudTrail for EC2 lifecycle events (stop, start, terminate, reboot). Shows WHO performed the action, WHEN, and state transitions. Essential for determining if downtime was user-initiated vs crash.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              resource_id: { type: "string", description: "AWS resource ID (e.g., i-0abc123)" },
              account: { type: "string", description: "Account name or 'all' (default: all)" },
              event_names: { type: "string", description: "Comma-separated event names (default: StopInstances,StartInstances,TerminateInstances,RebootInstances)" },
              hours_back: { type: "number", description: "Hours to look back (default: 168, max ~2160 for 90-day CloudTrail limit)" },
              limit: { type: "number", description: "Max events (default: 50)" },
            },
            required: ["resource_id"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "get_cloudwatch_metrics",
        description: "Query CloudWatch for EC2 instance metrics (CPU, status checks, network, disk). Returns time-series data with min/max/avg summary.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              instance_id: { type: "string", description: "EC2 instance ID (e.g., i-0abc123)" },
              account: { type: "string", description: "Account name (default: prod)" },
              metrics: { type: "string", description: "Comma-separated metric names (default: CPUUtilization,StatusCheckFailed)" },
              hours_back: { type: "number", description: "Hours to look back (default: 24)" },
              period_minutes: { type: "number", description: "Aggregation period in minutes (default: 5)" },
            },
            required: ["instance_id"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "load_domain_knowledge",
        description: "Load investigation runbooks for a specific domain. Call this early (Round 1) with the alert text to get domain-specific guidance on what to check, common patterns, and investigation strategies. Returns runbook content matched to the alert's domain (AWS, network, security, identity, application).",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              alert_text: { type: "string", description: "The alert subject and body text — used to classify the domain" },
              domains: { type: "array", items: { type: "string" }, description: "Optional: explicitly specify domains to load (e.g., ['aws', 'security'])" },
            },
            required: ["alert_text"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "check_investigation_quality",
        description: "Check past investigation quality data — ratings, common misdiagnosis types, and accuracy by domain and alert type. Call this early to learn what investigation approaches have worked or failed for similar alerts.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              alert_domain: { type: "string", description: "Filter by domain (e.g., 'security', 'infrastructure', 'work')" },
              alert_type: { type: "string", description: "Filter by alert type (e.g., 'security', 'outage', 'access')" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "check_remediation_outcomes",
        description: "Check past remediation outcomes to learn what has worked or failed for similar alert types and domains. Call this before proposing remediation to avoid repeating failures and build on successes.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              alert_domain: { type: "string", description: "Filter by domain (e.g., 'security', 'infrastructure', 'application')" },
              alert_type: { type: "string", description: "Filter by alert type (e.g., 'sg_open_port', 'high_cpu')" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "request_data_source",
        description: "Flag a missing data source that would help resolve this investigation. Call this when you need access to a system, tool, or data that isn't available. The gap will be recorded for future tool development. Continue investigating with available tools after calling this.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              data_source_name: { type: "string", description: "Name of the system/tool/data source needed (e.g., 'Datadog APM', 'PagerDuty incidents', 'container runtime logs')" },
              reason: { type: "string", description: "Why this data source is needed for this investigation" },
              criteria_blocked: {
                type: "array",
                items: { type: "string" },
                description: "Which investigation criteria cannot be verified without this data source",
              },
            },
            required: ["data_source_name", "reason", "criteria_blocked"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "submit_diagnosis",
        description: "Submit your final investigation diagnosis. Call this ONLY when all investigation criteria are resolved. This terminates the investigation.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["critical", "high", "medium", "low", "informational"], description: "Alert severity assessment" },
              summary: { type: "string", description: "One-paragraph diagnosis summary" },
              root_cause: { type: "string", description: "What caused this alert — must cite specific evidence" },
              evidence: {
                type: "array",
                items: { type: "string" },
                description: "Specific evidence items supporting the diagnosis (min 2)",
              },
              evidence_chain: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    claim: { type: "string", description: "What you observed or concluded" },
                    tool_used: { type: "string", description: "Which tool provided this evidence" },
                    raw_value: { type: "string", description: "The specific value or data returned by the tool" },
                    resource_id: { type: "string", description: "The resource identifier (instance ID, hostname, account, etc.)" },
                  },
                  required: ["claim", "tool_used", "raw_value", "resource_id"],
                },
                description: "Structured evidence chain — each claim linked to specific tool output (min 1)",
              },
              differentials: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    hypothesis: { type: "string", description: "Alternative explanation for the observed symptoms" },
                    evidence_for: { type: "array", items: { type: "string" }, description: "Evidence supporting this alternative" },
                    evidence_against: { type: "array", items: { type: "string" }, description: "Evidence contradicting this alternative" },
                    why_rejected: { type: "string", description: "Why primary diagnosis is preferred over this alternative" },
                  },
                  required: ["hypothesis", "evidence_against", "why_rejected"],
                },
                description: "Alternative hypotheses that were considered and eliminated (min 2)",
              },
              affected_systems: {
                type: "array",
                items: { type: "string" },
                description: "Systems, services, or accounts affected",
              },
              recommended_actions: {
                type: "array",
                items: { type: "string" },
                description: "Specific, actionable next steps (min 1)",
              },
              confidence: { type: "string", enum: ["high", "medium", "low"], description: "Confidence in the diagnosis. Only 'high' is accepted as complete — 'medium' and 'low' may be rejected." },
              missing_data_sources: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Name of the missing data source" },
                    reason: { type: "string", description: "Why it was needed" },
                  },
                  required: ["name", "reason"],
                },
                description: "Data sources that were needed but unavailable (from request_data_source calls)",
              },
              criteria_status: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    criterion: { type: "string", description: "Investigation question" },
                    status: { type: "string", enum: ["verified", "needs_data_source"], description: "Resolution status — verified (with evidence) or needs_data_source (what system/data is needed)" },
                    evidence: { type: "string", description: "Evidence supporting verification, or description of what data source is needed and why" },
                  },
                  required: ["criterion", "status", "evidence"],
                },
                description: "Status of each investigation criterion you identified",
              },
              remediation_proposal: {
                type: "object",
                description: "Optional: structured remediation proposal. Omit if no remediation is appropriate or issue is informational.",
                properties: {
                  description: { type: "string", description: "Clear description of what this remediation does and why" },
                  action_type: { type: "string", enum: ["automated", "manual"], description: "automated = system executes commands after approval; manual = human action items tracked as acknowledged" },
                  target_resource: { type: "string", description: "The specific resource ID to act on" },
                  commands: { type: "array", items: { type: "string" }, description: "Shell commands to execute (automated only). MUST be aws or az CLI commands." },
                  rollback_commands: { type: "array", items: { type: "string" }, description: "Commands to reverse the action (automated only)" },
                  blast_radius: { type: "string", description: "What else could be affected — specific dependent services, users, or systems" },
                  remediation_confidence: { type: "string", enum: ["high", "medium", "low"], description: "How confident this fixes the root cause" },
                  reasoning: { type: "string", description: "Evidence-based reasoning for this specific approach" },
                },
                required: ["description", "action_type", "target_resource", "blast_radius", "remediation_confidence", "reasoning"],
              },
            },
            required: ["severity", "summary", "root_cause", "evidence", "evidence_chain", "differentials", "affected_systems", "recommended_actions", "confidence", "criteria_status"],
          },
        },
      },
    },
    // ── Sophos Central tools ──
    {
      toolSpec: {
        name: "sophos_list_endpoints",
        description: "List managed endpoints from Sophos Central with health status. Use to check endpoint protection status, find unhealthy machines, or verify tamper protection.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              search: { type: "string", description: "Search by hostname or IP" },
              health_status: { type: "string", enum: ["good", "suspicious", "bad"], description: "Filter by health status" },
              type: { type: "string", enum: ["computer", "server"], description: "Filter by endpoint type" },
              limit: { type: "number", description: "Max results (default 50)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "sophos_get_alerts",
        description: "Get security alerts from Sophos Central. Use to check for malware detections, policy violations, endpoint threats, and security events.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              category: { type: "string", description: "Alert category (e.g., malware, pua, runtimeDetections, policy, protection)" },
              severity: { type: "string", enum: ["high", "medium", "low"], description: "Filter by severity" },
              limit: { type: "number", description: "Max results (default 50)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "sophos_get_events",
        description: "Query SIEM events from Sophos Central. Use to investigate endpoint activity, threat detections, and security events over a time range.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              hours: { type: "number", description: "Lookback hours (default 24)" },
              event_type: { type: "string", description: "Filter events by type or name keyword" },
              limit: { type: "number", description: "Max results (default 100)" },
            },
            required: [],
          },
        },
      },
    },
    // ── SigNoz tools ──
    {
      toolSpec: {
        name: "signoz_query_logs",
        description: "Search application and infrastructure logs in SigNoz. Use to investigate errors, trace requests, and find log entries matching a query string.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search string to match in log body" },
              minutes: { type: "number", description: "Lookback minutes (default 60)" },
              limit: { type: "number", description: "Max results (default 100)" },
              severity_text: { type: "string", description: "Filter by severity (ERROR, WARN, INFO, DEBUG)" },
              service_name: { type: "string", description: "Filter by service name" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "signoz_get_alerts",
        description: "Get alert rules and their firing status from SigNoz. Use to check which monitoring alerts are currently firing or recently triggered.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["firing", "inactive", "disabled"], description: "Filter by alert state" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "signoz_query_metrics",
        description: "Query infrastructure and application metrics from SigNoz. Use to check CPU, memory, request rates, error rates, and custom metrics over time.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              metric_name: { type: "string", description: "Metric name (e.g., system.cpu.utilization, http.server.request.duration)" },
              minutes: { type: "number", description: "Lookback minutes (default 60)" },
              aggregate: { type: "string", enum: ["avg", "sum", "min", "max", "count", "rate"], description: "Aggregation function (default avg)" },
              group_by: { type: "string", description: "Group by tag key" },
              service_name: { type: "string", description: "Filter by service name" },
            },
            required: ["metric_name"],
          },
        },
      },
    },
    // ── Cloudflare tools ──
    {
      toolSpec: {
        name: "cloudflare_list_zones",
        description: "List DNS zones managed in Cloudflare. Use to find zone IDs needed for DNS or firewall queries, check zone status, and verify configuration.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              search: { type: "string", description: "Search by domain name" },
              status: { type: "string", enum: ["active", "pending", "initializing", "moved", "deleted", "deactivated"], description: "Filter by zone status" },
              limit: { type: "number", description: "Max results (default 50)" },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "cloudflare_get_dns",
        description: "Get DNS records for a Cloudflare zone. Use to verify DNS configuration, check record values, and investigate DNS-related issues. Requires zone_id from cloudflare_list_zones.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              zone_id: { type: "string", description: "Cloudflare zone ID (from cloudflare_list_zones)" },
              search: { type: "string", description: "Search by record name" },
              type: { type: "string", enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "SPF"], description: "Filter by record type" },
              limit: { type: "number", description: "Max results (default 100)" },
            },
            required: ["zone_id"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "cloudflare_get_firewall_events",
        description: "Query WAF and firewall events for a Cloudflare zone. Use to investigate blocked requests, DDoS events, and security incidents. Requires zone_id from cloudflare_list_zones.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              zone_id: { type: "string", description: "Cloudflare zone ID (from cloudflare_list_zones)" },
              hours: { type: "number", description: "Lookback hours (default 24)" },
              action: { type: "string", enum: ["block", "challenge", "js_challenge", "managed_challenge", "allow", "log", "bypass"], description: "Filter by firewall action" },
              limit: { type: "number", description: "Max results (default 50)" },
            },
            required: ["zone_id"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "context7_resolve_library",
        description: "Resolve a vendor or library name to a Context7 library ID for documentation lookups. Call this first to get the library_id, then use context7_query_docs to retrieve relevant documentation. Useful for looking up AWS, Cloudflare, Okta, Azure, Tailscale, and other vendor documentation during investigations.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              library_name: { type: "string", description: "Vendor or library name to search (e.g., 'aws', 'cloudflare', 'okta', 'azure')" },
              query: { type: "string", description: "Context for the search to rank results by relevance (default: 'documentation')" },
            },
            required: ["library_name"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "context7_query_docs",
        description: "Query vendor documentation from Context7. Returns up-to-date documentation snippets and code examples for a specific library. Requires a library_id from context7_resolve_library (e.g., '/websites/aws_amazon'). Use this to look up API usage, CLI commands, configuration options, and troubleshooting guides during investigations.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              library_id: { type: "string", description: "Context7 library ID (e.g., '/websites/aws_amazon', '/cloudflare/cloudflare-docs'). Get this from context7_resolve_library." },
              query: { type: "string", description: "Specific question about the library (e.g., 'how to list EC2 instances', 'WAF rule configuration')" },
            },
            required: ["library_id", "query"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "query_steampipe",
        description: "Run a read-only SQL query against steampipe for cross-account AWS resource lookups. Steampipe provides unified SQL access to all 16 Buxton AWS accounts (aws, aws_prod, aws_ai_dev, aws_audit, aws_dev01, aws_qat, aws_uat, aws_testing, aws_contractors, aws_dr, aws_data_collection, aws_logs, aws_log_archive, aws_org, aws_dev, aws_imladris) plus AzureAD, Cloudflare, and GitHub. Use standard PostgreSQL syntax. Common tables: aws_ec2_instance, aws_s3_bucket, aws_iam_user, aws_vpc_security_group, aws_cloudtrail_trail_event, aws_rds_db_instance, aws_lambda_function, aws_ecs_service, aws_cost_by_service_daily. Results limited to 100 rows. No write operations allowed.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              query: { type: "string", description: "SQL query to execute against steampipe (e.g., \"SELECT instance_id, instance_state, account_id FROM aws_ec2_instance WHERE instance_state = 'running'\")" },
            },
            required: ["query"],
          },
        },
      },
    },
  ],
};

// ── Tool Execution ──

async function callWindmillTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ success: boolean; result: unknown; error?: string }> {
  const scriptPath = `f/investigate/${toolName}`;
  const url = `${WM_BASE}/api/w/${WM_WORKSPACE}/jobs/run_wait_result/p/${scriptPath}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WM_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { success: false, result: null, error: `HTTP ${resp.status}: ${body.slice(0, 500)}` };
    }

    const result = await resp.json();
    return { success: true, result };
  } catch (err: any) {
    if (err.name === "AbortError") {
      return { success: false, result: null, error: `Tool ${toolName} timed out after ${TOOL_TIMEOUT_MS}ms` };
    }
    return { success: false, result: null, error: err.message?.slice(0, 500) };
  }
}

function truncateResult(result: unknown): string {
  const json = JSON.stringify(result);
  if (json.length <= MAX_TOOL_RESULT_BYTES) return json;
  return json.slice(0, MAX_TOOL_RESULT_BYTES) + `... [truncated from ${json.length} bytes]`;
}

// ── Main Entry Point ──

export async function main(
  source: string,
  subject: string,
  body: string,
  sender: string,
  item_id: string,
  triage_classification: string = "",
  related_alerts: string[] = [],
  dedup_hash: string = "",
): Promise<{
  diagnosis?: Record<string, unknown>;
  error?: string;
  rounds: number;
  item_id: string;
  needs_review: boolean;
  missing_data_sources: Array<{ name: string; reason: string }>;
  usage: { input_tokens: number; output_tokens: number };
}> {
  // Helper: write investigation result directly to cache (decoupled from orchestrator)
  const writeResultToCache = (result: any, status: string) => {
    if (!dedup_hash) return; // backward compat: skip if no dedup_hash provided
    try {
      // Assess quality inline (same logic as process_actionable's assessInvestigationQuality)
      let quality = status;
      if (status === "success") {
        const diag = result.diagnosis;
        if (!diag) {
          quality = result.error ? "error" : "empty";
        } else if (result.needs_review) {
          quality = "needs_review";
        } else {
          quality = "substantial";
        }
        // Auto-dismiss: informational/low severity with high confidence
        if (quality === "substantial" && diag?.confidence === "high"
            && (diag?.severity === "informational" || diag?.severity === "low")) {
          quality = "dismissed";
        }
      }
      const resultJson = JSON.stringify(result);
      const waitingReason = (quality === "needs_review" || quality === "waiting_context")
        && result.diagnosis?.root_cause
        ? result.diagnosis.root_cause.slice(0, 500)
        : null;
      cacheLib.updateInvestigationStatus(dedup_hash, quality, resultJson, waitingReason);
      // Record capability gaps
      const gaps = result.missing_data_sources as Array<{ name: string; reason: string }> | undefined;
      if (gaps?.length) {
        for (const gap of gaps) {
          try { cacheLib.recordCapabilityGap(gap.name, gap.reason); } catch { /* best-effort */ }
        }
      }
      // Update investigation_jobs tracking table
      const jobId = process.env.WM_JOB_ID;
      if (jobId) {
        const summary = `${result.rounds || 0} rounds, ${result.diagnosis?.confidence || "unknown"} confidence, ${quality}`;
        cacheLib.updateInvestigationJobStatus(jobId, quality === "error" ? "failed" : "completed", summary);
      }
      console.log(`[agentic_investigator] Results written to cache: quality=${quality}, dedup_hash=${dedup_hash.slice(0, 12)}`);
    } catch (err: any) {
      console.error(`[agentic_investigator] Cache write failed (non-fatal): ${err.message?.slice(0, 200)}`);
    }
  };

  if (!WM_TOKEN) {
    const errResult = { error: "No WM_TOKEN available", rounds: 0, item_id, needs_review: false, missing_data_sources: [], usage: { input_tokens: 0, output_tokens: 0 } };
    writeResultToCache(errResult, "error");
    return errResult;
  }

  const client = new BedrockRuntimeClient({ region: "us-east-1" });

  // Phase 4c: prepend PAI institutional context (methodology + relevant memory)
  // to the system prompt for this investigation. Fails open if Postgres is down.
  const taskDesc = `${subject} — ${triage_classification || "unclassified"} — ${source}`;
  const paiContext = await fetchPAIContext(taskDesc);
  const system: SystemContentBlock[] = [{ text: SYSTEM_PROMPT + paiContext }];

  // Build initial user message with alert context
  const alertContext = [
    `SOURCE: ${source}`,
    `SENDER: ${sender}`,
    `SUBJECT: ${subject}`,
    triage_classification ? `CLASSIFICATION: ${triage_classification}` : "",
    related_alerts.length ? `RELATED ALERTS: ${related_alerts.join("; ")}` : "",
    `\nALERT BODY:\n${body}`,
  ]
    .filter(Boolean)
    .join("\n");

  const messages: Message[] = [
    {
      role: "user",
      content: [{ text: `Investigate this alert:\n\n${alertContext}` }],
    },
  ];

  let totalUsage = { input_tokens: 0, output_tokens: 0 };
  const requestedDataSources: Array<{ name: string; reason: string }> = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // Inject nudge at NUDGE_AT
    if (round === NUDGE_AT) {
      messages.push({
        role: "user",
        content: [
          {
            text: "You are entering the VERIFY phase. You have 2 rounds remaining. Before submitting: (1) Test your primary diagnosis against alternative hypotheses — cite evidence that eliminates each alternative. (2) Audit your evidence chain — every claim must trace to a specific tool output. (3) Adversarial self-check: what would disprove this diagnosis? Then call submit_diagnosis with complete evidence_chain and differentials.",
          },
        ],
      });
    }

    console.log(`[agentic_investigator] Round ${round}/${MAX_ROUNDS} for item ${item_id}`);

    const response = await client.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system,
        messages,
        toolConfig: TOOLS,
        inferenceConfig: { maxTokens: 4096 },
      }),
    );

    // Track usage
    if (response.usage) {
      totalUsage.input_tokens += response.usage.inputTokens || 0;
      totalUsage.output_tokens += response.usage.outputTokens || 0;
    }

    const assistantContent = response.output?.message?.content;
    if (!assistantContent) {
      const noContentResult = { error: "No content in response", rounds: round, item_id, needs_review: true, missing_data_sources: requestedDataSources, usage: totalUsage };
      writeResultToCache(noContentResult, "error");
      return noContentResult;
    }

    // Add assistant message to conversation
    messages.push({ role: "assistant", content: assistantContent });

    // Check for tool use
    const toolUseBlocks = assistantContent.filter(
      (block): block is ContentBlock & { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } } =>
        "toolUse" in block && block.toolUse !== undefined,
    );

    // No tool calls — model is done (end_turn)
    if (toolUseBlocks.length === 0) {
      // Extract any text response as a fallback diagnosis
      const textContent = assistantContent
        .filter((block): block is ContentBlock & { text: string } => "text" in block)
        .map((block) => block.text)
        .join("\n");

      const endTurnResult = {
        diagnosis: { summary: textContent, note: "Model ended without submit_diagnosis" },
        rounds: round,
        item_id,
        needs_review: true,
        missing_data_sources: requestedDataSources,
        usage: totalUsage,
      };
      writeResultToCache(endTurnResult, "success");
      return endTurnResult;
    }

    // Handle request_data_source calls — accumulate and respond inline
    const dataSourceBlocks = toolUseBlocks.filter((b) => b.toolUse.name === "request_data_source");
    for (const dsBlock of dataSourceBlocks) {
      const input = dsBlock.toolUse.input as { data_source_name: string; reason: string; criteria_blocked: string[] };
      // Only allow after round 2 to prevent premature bail-out
      if (round <= 2) {
        console.log(`[agentic_investigator] Rejecting premature request_data_source at round ${round}: ${input.data_source_name}`);
      } else {
        console.log(`[agentic_investigator] Data source gap flagged: ${input.data_source_name} — ${input.reason}`);
        requestedDataSources.push({ name: input.data_source_name, reason: input.reason });
      }
    }

    // Handle check_investigation_quality calls — respond inline from cache_lib
    const invQualityBlocks = toolUseBlocks.filter((b) => b.toolUse.name === "check_investigation_quality");
    for (const iqBlock of invQualityBlocks) {
      const input = iqBlock.toolUse.input as { alert_domain?: string; alert_type?: string };
      const quality = cacheLib.getInvestigationQuality(input.alert_domain, input.alert_type, 10);
      console.log(`[agentic_investigator] Investigation quality query: domain=${input.alert_domain || "all"}, type=${input.alert_type || "all"}, results=${quality.length}`);
    }

    // Handle check_remediation_outcomes calls — respond inline from cache_lib
    const remOutcomeBlocks = toolUseBlocks.filter((b) => b.toolUse.name === "check_remediation_outcomes");
    for (const roBlock of remOutcomeBlocks) {
      const input = roBlock.toolUse.input as { alert_domain?: string; alert_type?: string };
      const outcomes = cacheLib.getRemediationOutcomes(input.alert_domain, input.alert_type, 10);
      console.log(`[agentic_investigator] Remediation outcomes query: domain=${input.alert_domain || "all"}, type=${input.alert_type || "all"}, results=${outcomes.length}`);
    }

    // Tools handled inline (not via callWindmillTool)
    const inlineHandledTools = new Set(["submit_diagnosis", "request_data_source", "check_remediation_outcomes", "check_investigation_quality"]);

    // Check for submit_diagnosis among tool calls
    const diagnosisBlock = toolUseBlocks.find((b) => b.toolUse.name === "submit_diagnosis");
    if (diagnosisBlock) {
      const diagnosis = diagnosisBlock.toolUse.input as Record<string, unknown>;
      const confidence = diagnosis.confidence as string;
      const isLastRound = round >= MAX_ROUNDS;

      // ── Evidence chain & differential validation ──
      const evidenceChain = diagnosis.evidence_chain as Array<Record<string, unknown>> | undefined;
      const differentials = diagnosis.differentials as Array<Record<string, unknown>> | undefined;

      if (!evidenceChain || evidenceChain.length < 1) {
        console.log(`[agentic_investigator] Rejecting diagnosis: missing evidence_chain at round ${round}`);
        const structureRejectResults: ContentBlock[] = [
          {
            toolResult: {
              toolUseId: diagnosisBlock.toolUse.toolUseId,
              content: [{ text: "Diagnosis rejected: evidence_chain is required. Every key claim must cite a specific tool, the raw value returned, and the resource ID. Resubmit with at least 1 evidence_chain entry." }],
              status: "error",
            },
          },
        ];
        // Handle other tool calls in this round
        for (const block of toolUseBlocks) {
          if (block.toolUse.name === "submit_diagnosis") continue;
          if (inlineHandledTools.has(block.toolUse.name) && block.toolUse.name !== "submit_diagnosis") {
            structureRejectResults.push({ toolResult: { toolUseId: block.toolUse.toolUseId, content: [{ text: "Noted." }], status: "success" } });
            continue;
          }
          const toolResult = await callWindmillTool(block.toolUse.name, block.toolUse.input);
          structureRejectResults.push({ toolResult: { toolUseId: block.toolUse.toolUseId, content: [{ text: truncateResult(toolResult.success ? toolResult.result : { error: toolResult.error }) }], status: toolResult.success ? "success" : "error" } });
        }
        messages.push({ role: "user", content: structureRejectResults });
        continue;
      }

      if (!differentials || differentials.length < 2) {
        console.log(`[agentic_investigator] Rejecting diagnosis: insufficient differentials (${differentials?.length || 0}) at round ${round}`);
        const diffRejectResults: ContentBlock[] = [
          {
            toolResult: {
              toolUseId: diagnosisBlock.toolUse.toolUseId,
              content: [{ text: "Diagnosis rejected: you must consider at least 2 alternative hypotheses before submitting. For each alternative, explain what evidence supports it, what contradicts it, and why you rejected it. This prevents tunnel vision." }],
              status: "error",
            },
          },
        ];
        for (const block of toolUseBlocks) {
          if (block.toolUse.name === "submit_diagnosis") continue;
          if (inlineHandledTools.has(block.toolUse.name) && block.toolUse.name !== "submit_diagnosis") {
            diffRejectResults.push({ toolResult: { toolUseId: block.toolUse.toolUseId, content: [{ text: "Noted." }], status: "success" } });
            continue;
          }
          const toolResult = await callWindmillTool(block.toolUse.name, block.toolUse.input);
          diffRejectResults.push({ toolResult: { toolUseId: block.toolUse.toolUseId, content: [{ text: truncateResult(toolResult.success ? toolResult.result : { error: toolResult.error }) }], status: toolResult.success ? "success" : "error" } });
        }
        messages.push({ role: "user", content: diffRejectResults });
        continue;
      }

      // ── Confidence gate ──
      // High confidence: always accepted
      // Medium confidence: rejected before round 8, accepted at 8+ with needs_review
      // Low confidence: rejected at all rounds except last, accepted at last with needs_review
      let shouldReject = false;
      let rejectMessage = "";

      if (confidence === "low" && !isLastRound) {
        shouldReject = true;
        rejectMessage = "Diagnosis rejected: low confidence. You have rounds remaining. Use more tools to gather evidence. If you need a data source that doesn't exist, call request_data_source to flag it. Every criterion should be 'verified' or 'needs_data_source' — there is no 'unresolvable'.";
      } else if (confidence === "medium" && round < NUDGE_AT) {
        shouldReject = true;
        rejectMessage = "Diagnosis rejected: only high confidence is accepted this early. You have rounds remaining — investigate further. Check: have you used all relevant tools? Are there criteria you haven't verified? If you're blocked by a missing data source, call request_data_source.";
      }

      if (shouldReject) {
        console.log(`[agentic_investigator] Rejecting ${confidence}-confidence diagnosis at round ${round}`);
        const rejectResults: ContentBlock[] = [
          {
            toolResult: {
              toolUseId: diagnosisBlock.toolUse.toolUseId,
              content: [{ text: rejectMessage }],
              status: "error",
            },
          },
        ];

        // Also handle any other tool calls in this round (including data source responses)
        for (const block of toolUseBlocks) {
          if (block.toolUse.name === "submit_diagnosis") continue;
          if (block.toolUse.name === "request_data_source") {
            const dsInput = block.toolUse.input as { data_source_name: string };
            rejectResults.push({
              toolResult: {
                toolUseId: block.toolUse.toolUseId,
                content: [{ text: round <= 2 ? `Gap noted but too early — investigate with available tools first before flagging gaps. Try using existing tools to answer your criteria.` : `Data source gap recorded: ${dsInput.data_source_name}. Continue investigating with available tools.` }],
                status: "success",
              },
            });
            continue;
          }
          if (inlineHandledTools.has(block.toolUse.name)) {
            rejectResults.push({ toolResult: { toolUseId: block.toolUse.toolUseId, content: [{ text: "Noted." }], status: "success" } });
            continue;
          }
          const toolResult = await callWindmillTool(block.toolUse.name, block.toolUse.input);
          rejectResults.push({
            toolResult: {
              toolUseId: block.toolUse.toolUseId,
              content: [{ text: truncateResult(toolResult.success ? toolResult.result : { error: toolResult.error }) }],
              status: toolResult.success ? "success" : "error",
            },
          });
        }

        messages.push({ role: "user", content: rejectResults });
        continue;
      }

      // Accepted diagnosis — determine if it needs human review
      const needsReview = confidence !== "high" || isLastRound;
      // Merge any accumulated data source gaps into the diagnosis
      if (requestedDataSources.length > 0) {
        diagnosis.missing_data_sources = requestedDataSources;
      }

      console.log(`[agentic_investigator] Diagnosis submitted at round ${round} (confidence: ${confidence}, needs_review: ${needsReview})`);
      const diagResult = { diagnosis, rounds: round, item_id, needs_review: needsReview, missing_data_sources: requestedDataSources, usage: totalUsage };
      writeResultToCache(diagResult, "success");
      return diagResult;
    }

    // Execute regular tool calls (not inline-handled) in parallel
    const regularToolBlocks = toolUseBlocks.filter(
      (b) => !inlineHandledTools.has(b.toolUse.name),
    );

    const toolResults = await Promise.allSettled(
      regularToolBlocks.map(async (block) => {
        const { toolUseId, name, input } = block.toolUse;
        console.log(`[agentic_investigator] Calling tool: ${name}`);
        const result = await callWindmillTool(name, input);
        return {
          toolUseId,
          name,
          result,
        };
      }),
    );

    // Build tool result message
    const toolResultContent: ContentBlock[] = toolResults.map((settled) => {
      if (settled.status === "fulfilled") {
        const { toolUseId, result } = settled.value;
        return {
          toolResult: {
            toolUseId,
            content: [{ text: truncateResult(result.success ? result.result : { error: result.error }) }],
            status: (result.success ? "success" : "error") as "success" | "error",
          },
        };
      } else {
        // Promise.allSettled rejection — shouldn't happen but handle gracefully
        return {
          toolResult: {
            toolUseId: "unknown",
            content: [{ text: JSON.stringify({ error: "Internal execution error" }) }],
            status: "error" as const,
          },
        };
      }
    });

    // Add data source request responses
    for (const dsBlock of dataSourceBlocks) {
      const dsInput = dsBlock.toolUse.input as { data_source_name: string };
      toolResultContent.push({
        toolResult: {
          toolUseId: dsBlock.toolUse.toolUseId,
          content: [{ text: round <= 2 ? `Gap noted but too early — investigate with available tools first before flagging gaps. Try using existing tools to answer your criteria.` : `Data source gap recorded: ${dsInput.data_source_name}. Continue investigating with available tools — do your best with what you have.` }],
          status: "success" as const,
        },
      });
    }

    // Add investigation quality responses
    for (const iqBlock of invQualityBlocks) {
      const input = iqBlock.toolUse.input as { alert_domain?: string; alert_type?: string };
      const quality = cacheLib.getInvestigationQuality(input.alert_domain, input.alert_type, 10);
      const summary = quality.length === 0
        ? "No past investigation quality data found for this domain/alert type."
        : JSON.stringify(quality.map((q: any) => ({
            rating: q.rating, misdiagnosis_type: q.misdiagnosis_type,
            domain: q.alert_domain, type: q.alert_type,
            notes: q.notes, rated_at: q.rated_at,
          })));
      toolResultContent.push({
        toolResult: {
          toolUseId: iqBlock.toolUse.toolUseId,
          content: [{ text: truncateResult(summary) }],
          status: "success" as const,
        },
      });
    }

    // Add remediation outcomes responses
    for (const roBlock of remOutcomeBlocks) {
      const input = roBlock.toolUse.input as { alert_domain?: string; alert_type?: string };
      const outcomes = cacheLib.getRemediationOutcomes(input.alert_domain, input.alert_type, 10);
      const summary = outcomes.length === 0
        ? "No past remediation outcomes found for this domain/alert type. This will be the first."
        : JSON.stringify(outcomes.map(o => ({
            description: o.description, action_type: o.action_type, target: o.target_resource,
            success: !!o.execution_success, verified: o.verified === 1, rating: o.rating,
            rating_notes: o.rating_notes, domain: o.alert_domain, type: o.alert_type,
          })));
      toolResultContent.push({
        toolResult: {
          toolUseId: roBlock.toolUse.toolUseId,
          content: [{ text: truncateResult(summary) }],
          status: "success" as const,
        },
      });
    }

    messages.push({ role: "user", content: toolResultContent });
  }

  // Max rounds exhausted
  console.log(`[agentic_investigator] Max rounds (${MAX_ROUNDS}) reached for item ${item_id}`);
  const exhaustedResult = { error: `Investigation exhausted ${MAX_ROUNDS} rounds without diagnosis`, rounds: MAX_ROUNDS, item_id, needs_review: true, missing_data_sources: requestedDataSources, usage: totalUsage };
  writeResultToCache(exhaustedResult, "error");
  return exhaustedResult;
}
