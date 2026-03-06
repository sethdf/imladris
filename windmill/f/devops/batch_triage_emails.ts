// Windmill Script: Batch Triage Emails
// Layered pipeline: L1a dedup → L1b rules → L2 AI → store results.
// Only AI classification is rate-limited; L1 results are instant.

import { createHash } from "crypto";
import { bedrockInvoke, MODELS } from "./bedrock.ts";

// ── Windmill variable helper ──

async function getVariable(path: string): Promise<string | undefined> {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";
  if (!token) return undefined;
  try {
    const resp = await fetch(
      `${base}/api/w/${workspace}/variables/get_value/${path}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) return undefined;
    const val = await resp.text();
    const parsed = val.startsWith('"') ? JSON.parse(val) : val;
    return parsed.trim();
  } catch {
    return undefined;
  }
}

// ── HTML strip helper ──
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Graph API helpers ──

async function getGraphToken(): Promise<string> {
  const tenantId = await getVariable("f/devops/m365_tenant_id");
  const clientId = await getVariable("f/devops/m365_client_id");
  const clientSecret = await getVariable("f/devops/m365_client_secret");
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("M365 credentials not configured in Windmill variables");
  }
  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  if (!resp.ok) throw new Error(`Token request failed: ${resp.status}`);
  return (await resp.json()).access_token;
}

async function fetchUnreadEmails(
  token: string,
  userId: string,
  daysBack: number,
  maxResults: number,
): Promise<any[]> {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString();
  const filter = `isRead eq false and receivedDateTime ge ${sinceStr}`;
  const select = "id,subject,from,receivedDateTime,bodyPreview,body,importance";
  const pageSize = Math.min(maxResults, 200); // Graph API max per page
  let url: string | null =
    `https://graph.microsoft.com/v1.0/users/${userId}/messages` +
    `?$filter=${encodeURIComponent(filter)}` +
    `&$select=${select}` +
    `&$top=${pageSize}` +
    `&$orderby=receivedDateTime desc`;

  const allEmails: any[] = [];
  let page = 0;
  while (url && allEmails.length < maxResults) {
    page++;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Graph API ${resp.status}: ${body.slice(0, 300)}`);
    }
    const data = await resp.json();
    const emails = data.value || [];
    allEmails.push(...emails);
    console.log(`[fetch] Page ${page}: got ${emails.length} emails (total: ${allEmails.length})`);
    url = data["@odata.nextLink"] || null;
  }
  // Trim to maxResults if pagination overshot
  return allEmails.slice(0, maxResults);
}

async function markEmailRead(
  messageId: string,
  userId: string,
  token: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://graph.microsoft.com/v1.0/users/${userId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isRead: true }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// ── AI classification via Bedrock (Haiku) ──

interface Classification {
  action: "NOTIFY" | "QUEUE" | "AUTO";
  urgency: string;
  summary: string;
  reasoning: string;
  domain: string;
  entities: string[];
  alert_type: string;
  source_system: string;
  is_resolution: boolean;
}

async function classifyEmail(
  subject: string,
  from: string,
  preview: string,
  recentContext: string,
): Promise<Classification> {
  const content = `From: ${from}\nSubject: ${subject}\n\n${preview}`.slice(0, 2000);
  const contextBlock = recentContext
    ? `\nRecent history for this sender/subject:\n${recentContext}\n\nConsider whether this email represents an escalation, new pattern, or continuation of the above.\n`
    : "";
  const prompt = `You are an email triage system. Classify this email and extract structured metadata.
${contextBlock}
${content}

Respond with ONLY valid JSON (no markdown):
{
  "action": "NOTIFY|QUEUE|AUTO",
  "urgency": "critical|high|medium|low",
  "summary": "one sentence summary",
  "reasoning": "why this classification",
  "domain": "work|personal",
  "entities": ["lowercase server/service/system names mentioned, e.g. neostagedb01, solarwinds, okta"],
  "alert_type": "outage|security|access|change|license|info",
  "source_system": "name of the monitoring/alerting tool that sent this, e.g. DLP, Site24x7, PagerDuty, or empty string",
  "is_resolution": false
}

Rules:
- NOTIFY: Security alerts, service down, P1 incidents, anything needing immediate human attention
- QUEUE: New tickets, feature requests, non-urgent tasks — add to workstream for later
- AUTO: Informational digests, resolved alerts, routine maintenance, newsletters — log and move on
- critical/high -> NOTIFY, medium -> QUEUE or AUTO, low -> AUTO
- entities: extract all server names, service names, system names as lowercase. Omit generic words.
- alert_type: outage (down/up), security (DLP/breach/vulnerability), access (permissions/consent), change (config/deploy), license (renewal/expiry), info (newsletter/digest/report)
- is_resolution: true ONLY if this email indicates a problem is resolved (e.g. "is Up", "resolved", "closed")`;

  try {
    const inner = await bedrockInvoke(prompt, {
      model: MODELS.HAIKU,
      maxTokens: 384,
      timeoutMs: 30000,
      parseJson: true,
    });

    const validActions = ["NOTIFY", "QUEUE", "AUTO"];
    if (!validActions.includes(inner.action)) inner.action = "QUEUE";
    if (!Array.isArray(inner.entities)) inner.entities = [];
    if (!inner.alert_type) inner.alert_type = "info";
    if (!inner.source_system) inner.source_system = "";
    if (typeof inner.is_resolution !== "boolean") inner.is_resolution = false;
    return inner as Classification;
  } catch (err: any) {
    console.error(`[classify] Error: ${err.message?.slice(0, 300)}`);
    return {
      action: "QUEUE",
      urgency: "medium",
      summary: `CLASSIFY ERROR: ${err.message?.slice(0, 150)}`,
      reasoning: `Bedrock error: ${err.message?.slice(0, 200)}`,
      domain: "work",
      entities: [],
      alert_type: "info",
      source_system: "",
      is_resolution: false,
    };
  }
}

// ── Classification with time-series context ──

function computeDedupHash(subject: string, sender: string): string {
  const normalized = `${sender.toLowerCase().trim()}|${subject.toLowerCase().trim()}`;
  return createHash("sha256").update(normalized).digest("hex");
}

interface ClassificationResult extends Classification {
  classified_by: string;
  rule_id: number | null;
}

async function classifyWithContext(
  subject: string,
  sender: string,
  preview: string,
  cacheLib: any | null,
): Promise<ClassificationResult> {
  // Fetch recent history for time-series context
  let recentContext = "";
  if (cacheLib) {
    try {
      const dedupHash = computeDedupHash(subject, sender);
      const dedup = cacheLib.checkDedup(dedupHash);
      if (dedup.found && dedup.existing) {
        recentContext = `- Previously classified as ${dedup.existing.action} (${dedup.existing.urgency}): "${dedup.existing.summary}"`;
      }
    } catch { /* context is best-effort */ }
  }

  const aiResult = await classifyEmail(subject, sender, preview, recentContext);
  return {
    ...aiResult,
    classified_by: "L1_ai",
    rule_id: null,
  };
}

// ── Main ──

export async function main(
  days_back: number = 30,
  batch_size: number = 50,
  delay_ms: number = 2000,
  dry_run: boolean = false,
): Promise<{
  total_fetched: number;
  triaged: number;
  auto_count: number;
  queue_count: number;
  notify_count: number;
  errors: number;
  marked_read: number;
  layer_breakdown: { l1_ai: number };
  results: Array<{
    subject: string;
    action: string;
    urgency: string;
    summary: string;
    classified_by: string;
  }>;
}> {
  const startTime = Date.now();
  console.log(`[batch_triage] Starting: days_back=${days_back}, batch_size=${batch_size}, dry_run=${dry_run}`);

  // Try to load cache_lib for L1 layers — gracefully degrade if unavailable
  let cacheLib: any = null;
  try {
    cacheLib = await import("./cache_lib.ts");
    if (cacheLib.isAvailable()) {
      cacheLib.init();
      console.log("[batch_triage] Cache lib loaded — dedup active");
    } else {
      console.log("[batch_triage] Cache not available — dedup disabled, AI only");
      cacheLib = null;
    }
  } catch (e: any) {
    console.log(`[batch_triage] Cache lib not loaded: ${e.message?.slice(0, 100)} — AI only`);
    cacheLib = null;
  }

  // Get Graph API token
  const userId = "sfoley@buxtonco.com";
  let graphToken: string;
  try {
    graphToken = await getGraphToken();
    console.log(`[batch_triage] Graph API authenticated for user ${userId}`);
  } catch (err: any) {
    console.error(`[batch_triage] Auth failed: ${err.message}`);
    return {
      total_fetched: 0, triaged: 0, auto_count: 0, queue_count: 0,
      notify_count: 0, errors: 1, marked_read: 0,
      layer_breakdown: { l1_ai: 0 },
      results: [],
    };
  }

  // Fetch unread emails directly from Graph API
  let emails: any[];
  try {
    emails = await fetchUnreadEmails(graphToken, userId, days_back, batch_size);
    console.log(`[batch_triage] Fetched ${emails.length} unread emails.`);
  } catch (err: any) {
    console.error(`[batch_triage] Failed to fetch emails: ${err.message}`);
    return {
      total_fetched: 0, triaged: 0, auto_count: 0, queue_count: 0,
      notify_count: 0, errors: 1, marked_read: 0,
      layer_breakdown: { l1_ai: 0 },
      results: [],
    };
  }

  const results: Array<{ subject: string; action: string; urgency: string; summary: string; classified_by: string }> = [];
  let autoCount = 0, queueCount = 0, notifyCount = 0, errorCount = 0, markedRead = 0;
  const layerBreakdown = { l1_ai: 0 };
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const subject = email.subject || "No subject";
    const from = email.from?.emailAddress?.address || "unknown";
    const preview = email.bodyPreview || "";
    const bodyHtml = email.body?.content || "";
    const bodyText = bodyHtml ? stripHtml(bodyHtml) : preview;
    const receivedAt = email.receivedDateTime || "";

    console.log(`[batch_triage] [${i + 1}/${emails.length}] Triaging: ${subject.slice(0, 60)}...`);

    // Delay between AI calls to avoid throttling
    if (i > 0 && delay_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay_ms));
    }

    try {
      const classification = await classifyWithContext(subject, from, bodyText || preview, cacheLib);
      layerBreakdown.l1_ai++;

      results.push({
        subject: subject.slice(0, 100),
        action: classification.action,
        urgency: classification.urgency,
        summary: classification.summary,
        classified_by: classification.classified_by,
      });

      // Store result in triage_results
      if (cacheLib) {
        try {
          const dedupHash = computeDedupHash(subject, from);
          cacheLib.storeTriageResult({
            source: "m365",
            message_id: email.id || "",
            subject: subject.slice(0, 500),
            sender: from,
            received_at: receivedAt,
            action: classification.action,
            urgency: classification.urgency,
            summary: classification.summary,
            reasoning: classification.reasoning,
            domain: classification.domain,
            classified_by: classification.classified_by,
            rule_id: classification.rule_id,
            dedup_hash: dedupHash,
            marked_read: 0,
            metadata: JSON.stringify({ importance: email.importance, preview: preview.slice(0, 1000), body_text: bodyText.slice(0, 8000), is_resolution: classification.is_resolution }),
            entities: JSON.stringify(classification.entities),
            alert_type: classification.alert_type,
            source_system: classification.source_system,
          });
        } catch { /* best-effort storage */ }
      }

      switch (classification.action) {
        case "AUTO":
          autoCount++;
          if (!dry_run && email.id) {
            const marked = await markEmailRead(email.id, userId, graphToken);
            if (marked) markedRead++;
          }
          break;
        case "QUEUE": queueCount++; break;
        case "NOTIFY": notifyCount++; break;
      }

      console.log(`[batch_triage] [${i + 1}/${emails.length}] → ${classification.action} (${classification.urgency}) [${classification.classified_by}]: ${classification.summary.slice(0, 80)}`);
    } catch (err: any) {
      errorCount++;
      console.error(`[batch_triage] [${i + 1}/${emails.length}] Error: ${err.message?.slice(0, 200)}`);
      results.push({ subject: subject.slice(0, 100), action: "ERROR", urgency: "unknown", summary: err.message?.slice(0, 200) || "Unknown error", classified_by: "error" });
    }
  }

  const duration = Date.now() - startTime;
  console.log(`\n[batch_triage] Complete in ${(duration / 1000).toFixed(1)}s`);
  console.log(`[batch_triage] Results: ${autoCount} AUTO, ${queueCount} QUEUE, ${notifyCount} NOTIFY, ${errorCount} errors`);
  console.log(`[batch_triage] AI classifications: ${layerBreakdown.l1_ai}`);
  if (!dry_run) console.log(`[batch_triage] Marked read: ${markedRead}`);

  return {
    total_fetched: emails.length,
    triaged: emails.length - errorCount,
    auto_count: autoCount,
    queue_count: queueCount,
    notify_count: notifyCount,
    errors: errorCount,
    marked_read: markedRead,
    layer_breakdown: layerBreakdown,
    results,
  };
}
