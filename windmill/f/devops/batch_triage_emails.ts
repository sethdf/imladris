// Windmill Script: Batch Triage Emails
// Layered pipeline: L1a dedup → L1b rules → L2 AI → store results.
// Only AI classification is rate-limited; L1 results are instant.

import { createHash } from "crypto";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";

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
  const select = "id,subject,from,receivedDateTime,bodyPreview,importance";
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

// ── Inline classification via claude -p (Layer 2) ──

interface Classification {
  action: "NOTIFY" | "QUEUE" | "AUTO";
  urgency: string;
  summary: string;
  reasoning: string;
  domain: string;
}

function classifyEmail(subject: string, from: string, preview: string): Classification {
  const content = `From: ${from}\nSubject: ${subject}\n\n${preview}`.slice(0, 2000);
  const prompt = `You are an email triage system. Classify this email.

${content}

Respond with ONLY valid JSON (no markdown):
{
  "action": "NOTIFY|QUEUE|AUTO",
  "urgency": "critical|high|medium|low",
  "summary": "one sentence summary",
  "reasoning": "why this classification",
  "domain": "work|personal"
}

Rules:
- NOTIFY: Security alerts, service down, P1 incidents, anything needing immediate human attention
- QUEUE: New tickets, feature requests, non-urgent tasks — add to workstream for later
- AUTO: Informational digests, resolved alerts, routine maintenance, newsletters — log and move on
- critical/high -> NOTIFY, medium -> QUEUE or AUTO, low -> AUTO`;

  try {
    const tmpFile = `/tmp/batch-classify-${Date.now()}.txt`;
    writeFileSync(tmpFile, prompt);
    const result = execSync(
      `cat ${tmpFile} | claude -p 2>/dev/null`,
      { encoding: "utf-8", timeout: 60000 },
    ).trim();
    try { unlinkSync(tmpFile); } catch { /* best-effort */ }

    // Extract JSON from raw text response (may contain markdown wrappers)
    const jsonStart = result.indexOf("{");
    const jsonEnd = result.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      throw new Error(`No JSON object found in response: ${result.slice(0, 100)}`);
    }
    const jsonStr = result.slice(jsonStart, jsonEnd + 1);
    const inner = JSON.parse(jsonStr);

    const validActions = ["NOTIFY", "QUEUE", "AUTO"];
    if (!validActions.includes(inner.action)) inner.action = "QUEUE";
    return inner as Classification;
  } catch (err: any) {
    console.error(`[classify] Error: ${err.message?.slice(0, 300)}`);
    return {
      action: "QUEUE",
      urgency: "medium",
      summary: `CLASSIFY ERROR: ${err.message?.slice(0, 150)}`,
      reasoning: `claude -p error: ${err.message?.slice(0, 200)}`,
      domain: "work",
    };
  }
}

// ── Layered classification cascade ──

function computeDedupHash(subject: string, sender: string): string {
  const normalized = `${sender.toLowerCase().trim()}|${subject.toLowerCase().trim()}`;
  return createHash("sha256").update(normalized).digest("hex");
}

interface LayeredResult extends Classification {
  classified_by: string;
  rule_id: number | null;
}

function classifyLayered(
  messageId: string,
  subject: string,
  sender: string,
  preview: string,
  receivedAt: string,
  cacheLib: any | null,
): LayeredResult {
  const dedupHash = computeDedupHash(subject, sender);

  // Layer 1a: Dedup — same sender+subject within 4h window
  if (cacheLib) {
    try {
      const dedup = cacheLib.checkDedup(dedupHash);
      if (dedup.found && dedup.existing) {
        console.log(`[L1_dedup] Hit for: ${subject.slice(0, 50)}`);
        return {
          action: dedup.existing.action as Classification["action"],
          urgency: dedup.existing.urgency,
          summary: dedup.existing.summary,
          reasoning: `Dedup match (${dedup.existing.classified_by})`,
          domain: dedup.existing.domain,
          classified_by: "L1_dedup",
          rule_id: dedup.existing.rule_id,
        };
      }
    } catch (e: any) {
      console.error(`[L1_dedup] Error: ${e.message?.slice(0, 100)}`);
    }
  }

  // Layer 1b: Rules — glob pattern match
  if (cacheLib) {
    try {
      const rule = cacheLib.matchRule("m365", sender, subject);
      if (rule) {
        console.log(`[L1_rule] Matched "${rule.name}" for: ${subject.slice(0, 50)}`);
        cacheLib.incrementRuleHit(rule.id);
        return {
          action: rule.action as Classification["action"],
          urgency: rule.urgency,
          summary: rule.summary_template || `Rule: ${rule.name}`,
          reasoning: `Matched rule "${rule.name}" (priority ${rule.priority})`,
          domain: rule.domain,
          classified_by: "L1_rule",
          rule_id: rule.id,
        };
      }
    } catch (e: any) {
      console.error(`[L1_rule] Error: ${e.message?.slice(0, 100)}`);
    }
  }

  // Layer 2: AI classification
  const aiResult = classifyEmail(subject, sender, preview);
  return {
    ...aiResult,
    classified_by: "L2_ai",
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
  layer_breakdown: { l1_rule: number; l1_dedup: number; l2_ai: number };
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
      console.log("[batch_triage] Cache lib loaded — L1 layers active");
    } else {
      console.log("[batch_triage] Cache not available — L1 layers disabled, L2 only");
      cacheLib = null;
    }
  } catch (e: any) {
    console.log(`[batch_triage] Cache lib not loaded: ${e.message?.slice(0, 100)} — L2 only`);
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
      layer_breakdown: { l1_rule: 0, l1_dedup: 0, l2_ai: 0 },
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
      layer_breakdown: { l1_rule: 0, l1_dedup: 0, l2_ai: 0 },
      results: [],
    };
  }

  const results: Array<{ subject: string; action: string; urgency: string; summary: string; classified_by: string }> = [];
  let autoCount = 0, queueCount = 0, notifyCount = 0, errorCount = 0, markedRead = 0;
  const layerBreakdown = { l1_rule: 0, l1_dedup: 0, l2_ai: 0 };
  let lastWasAi = false;

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const subject = email.subject || "No subject";
    const from = email.from?.emailAddress?.address || "unknown";
    const preview = email.bodyPreview || "";
    const receivedAt = email.receivedDateTime || "";

    console.log(`[batch_triage] [${i + 1}/${emails.length}] Triaging: ${subject.slice(0, 60)}...`);

    // Only delay before L2 AI calls (not L1)
    if (lastWasAi && delay_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay_ms));
    }

    try {
      const classification = classifyLayered(email.id || "", subject, from, preview, receivedAt, cacheLib);
      lastWasAi = classification.classified_by === "L2_ai";

      // Track layer breakdown
      if (classification.classified_by === "L1_rule") layerBreakdown.l1_rule++;
      else if (classification.classified_by === "L1_dedup") layerBreakdown.l1_dedup++;
      else layerBreakdown.l2_ai++;

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
            metadata: JSON.stringify({ importance: email.importance, preview: preview.slice(0, 1000) }),
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
      lastWasAi = false;
      console.error(`[batch_triage] [${i + 1}/${emails.length}] Error: ${err.message?.slice(0, 200)}`);
      results.push({ subject: subject.slice(0, 100), action: "ERROR", urgency: "unknown", summary: err.message?.slice(0, 200) || "Unknown error", classified_by: "error" });
    }
  }

  const duration = Date.now() - startTime;
  console.log(`\n[batch_triage] Complete in ${(duration / 1000).toFixed(1)}s`);
  console.log(`[batch_triage] Results: ${autoCount} AUTO, ${queueCount} QUEUE, ${notifyCount} NOTIFY, ${errorCount} errors`);
  console.log(`[batch_triage] Layers: ${layerBreakdown.l1_dedup} dedup, ${layerBreakdown.l1_rule} rule, ${layerBreakdown.l2_ai} AI`);
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
