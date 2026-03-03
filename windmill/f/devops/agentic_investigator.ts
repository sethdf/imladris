// Windmill Script: Agentic Investigator (System 2)
// Bedrock Converse API tool-use loop — Opus investigates alerts using 16 read-only tools.
// Replaces investigate.ts (1100 LOC Steampipe cascade) with ~200 LOC agentic loop.
//
// Architecture:
//   - Bedrock Converse API via @aws-sdk/client-bedrock-runtime (ConverseCommand)
//   - 16 investigation tools from f/investigate/ executed via Windmill HTTP API
//   - ISC methodology: decompose → investigate → verify → submit
//   - Max 10 rounds, nudge at round 8, parallel tool execution
//   - Cost: ~$0.83/investigation at 5/day
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

// ── Constants ──

const MODEL_ID = "us.anthropic.claude-opus-4-6-v1";
const MAX_ROUNDS = 10;
const NUDGE_AT = 8;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_TOOL_RESULT_BYTES = 50_000;
const WM_BASE = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
const WM_TOKEN = process.env.WM_TOKEN;
const WM_WORKSPACE = process.env.WM_WORKSPACE || "imladris";

// ── System Prompt ──

const SYSTEM_PROMPT = `You are an expert DevOps/SecOps investigator for BuxtonIT. You receive alerts from email, Slack, and monitoring systems, and you must investigate them using the tools available to you.

INVESTIGATION APPROACH:
1. Before using any tools, identify what questions this specific alert requires you to answer (your investigation criteria). State them explicitly.
2. Use tools to answer each question with evidence. Execute multiple tool calls in a single turn when the queries are independent.
3. Before submitting, verify every question is answered or explicitly unresolvable.
4. Include your criteria and their resolution status in the diagnosis via submit_diagnosis.

RULES:
- Every conclusion MUST cite a specific tool result. Never infer without evidence.
- "Unknown" is always valid — never fabricate a diagnosis.
- All tools are READ-ONLY. You cannot modify any resource.
- If a tool returns an error about missing credentials, note it as NEEDS-CREDENTIAL and continue.
- Keep tool calls focused — use filters and limits to avoid pulling excessive data.
- When you have enough evidence, call submit_diagnosis immediately. Do not over-investigate.

ENVIRONMENT:
- AWS: 16 accounts in BuxtonIT org (767448074758 is imladris/local). All accessible via tools.
- Azure AD: Microsoft 365 tenant with user, device, and sign-in data.
- SDP: ServiceDesk Plus for ticket management.
- Securonix: SIEM for security incidents and violations.
- Site24x7: Infrastructure monitoring.
- Local cache: SQLite triage cache with alert history and resource inventory.`;

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
              confidence: { type: "string", enum: ["high", "medium", "low"], description: "Confidence in the diagnosis" },
              criteria_status: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    criterion: { type: "string", description: "Investigation question" },
                    status: { type: "string", enum: ["verified", "unresolvable"], description: "Resolution status" },
                    evidence: { type: "string", description: "Evidence or reason for unresolvable" },
                  },
                  required: ["criterion", "status", "evidence"],
                },
                description: "Status of each investigation criterion you identified",
              },
            },
            required: ["severity", "summary", "root_cause", "evidence", "affected_systems", "recommended_actions", "confidence", "criteria_status"],
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
): Promise<{
  diagnosis?: Record<string, unknown>;
  error?: string;
  rounds: number;
  item_id: string;
  usage: { input_tokens: number; output_tokens: number };
}> {
  if (!WM_TOKEN) {
    return { error: "No WM_TOKEN available", rounds: 0, item_id, usage: { input_tokens: 0, output_tokens: 0 } };
  }

  const client = new BedrockRuntimeClient({ region: "us-east-1" });
  const system: SystemContentBlock[] = [{ text: SYSTEM_PROMPT }];

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

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // Inject nudge at NUDGE_AT
    if (round === NUDGE_AT) {
      messages.push({
        role: "user",
        content: [
          {
            text: "You have 2 rounds remaining. Review your investigation criteria — which are still unresolved? Either resolve them now or mark them unresolvable with a reason. Then call submit_diagnosis.",
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
      return { error: "No content in response", rounds: round, item_id, usage: totalUsage };
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

      return {
        diagnosis: { summary: textContent, note: "Model ended without submit_diagnosis" },
        rounds: round,
        item_id,
        usage: totalUsage,
      };
    }

    // Check for submit_diagnosis among tool calls
    const diagnosisBlock = toolUseBlocks.find((b) => b.toolUse.name === "submit_diagnosis");
    if (diagnosisBlock) {
      const diagnosis = diagnosisBlock.toolUse.input as Record<string, unknown>;

      // Validate: reject premature low-confidence diagnosis before round 4
      if (diagnosis.confidence === "low" && round < 4) {
        console.log(`[agentic_investigator] Rejecting premature low-confidence diagnosis at round ${round}`);
        const rejectResults: ContentBlock[] = [
          {
            toolResult: {
              toolUseId: diagnosisBlock.toolUse.toolUseId,
              content: [
                {
                  text: "Diagnosis rejected: low confidence with many rounds remaining. Please investigate further — use more tools to gather evidence, or explain why further investigation won't help.",
                },
              ],
              status: "error",
            },
          },
        ];

        // Also handle any other tool calls in this round
        for (const block of toolUseBlocks) {
          if (block.toolUse.name !== "submit_diagnosis") {
            const toolResult = await callWindmillTool(block.toolUse.name, block.toolUse.input);
            rejectResults.push({
              toolResult: {
                toolUseId: block.toolUse.toolUseId,
                content: [{ text: truncateResult(toolResult.success ? toolResult.result : { error: toolResult.error }) }],
                status: toolResult.success ? "success" : "error",
              },
            });
          }
        }

        messages.push({ role: "user", content: rejectResults });
        continue;
      }

      // Accepted diagnosis
      console.log(`[agentic_investigator] Diagnosis submitted at round ${round} (confidence: ${diagnosis.confidence})`);
      return { diagnosis, rounds: round, item_id, usage: totalUsage };
    }

    // Execute all tool calls in parallel
    const toolResults = await Promise.allSettled(
      toolUseBlocks.map(async (block) => {
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

    messages.push({ role: "user", content: toolResultContent });
  }

  // Max rounds exhausted
  console.log(`[agentic_investigator] Max rounds (${MAX_ROUNDS}) reached for item ${item_id}`);
  return { error: `Investigation exhausted ${MAX_ROUNDS} rounds without diagnosis`, rounds: MAX_ROUNDS, item_id, usage: totalUsage };
}
