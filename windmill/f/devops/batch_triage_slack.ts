// Windmill Script: Batch Triage Slack Messages
// Layered pipeline: L1a dedup → L1b rules → L2 AI → store results.
// Mirrors batch_triage_emails.ts structure for Slack conversations.
// Top-level messages only (v1) — thread replies are a future enhancement.

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

// ── Slack API helpers ──

async function getSlackToken(): Promise<string> {
  const token = await getVariable("f/devops/slack_user_token");
  if (!token) {
    throw new Error("Slack user token not configured in Windmill variable f/devops/slack_user_token");
  }
  return token;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
  [key: string]: any;
}

async function slackApi(
  token: string,
  method: string,
  params: Record<string, string | number> = {},
): Promise<SlackApiResponse> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("Retry-After") || "5");
      console.log(`[slack] Rate limited, waiting ${retryAfter}s...`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (!resp.ok) {
      throw new Error(`Slack API ${method} HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
    const data = await resp.json();
    if (!data.ok) {
      throw new Error(`Slack API ${method} error: ${data.error}`);
    }
    return data as SlackApiResponse;
  }
  throw new Error(`Slack API ${method}: max retries exceeded (rate limited)`);
}

// ── User name resolution with cache ──

const userNameCache = new Map<string, string>();

async function resolveUserName(token: string, userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;
  try {
    const data = await slackApi(token, "users.info", { user: userId });
    const name = data.user?.real_name || data.user?.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch (e: any) {
    console.error(`[slack] Failed to resolve user ${userId}: ${e.message?.slice(0, 100)}`);
    userNameCache.set(userId, userId);
    return userId;
  }
}

// ── Conversation fetching ──

interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
  user?: string; // DM partner user ID
}

async function fetchAllConversations(
  token: string,
  maxChannels: number,
): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor = "";
  while (channels.length < maxChannels) {
    const params: Record<string, string | number> = {
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: "true",
      limit: Math.min(200, maxChannels - channels.length),
    };
    if (cursor) params.cursor = cursor;
    const data = await slackApi(token, "conversations.list", params);
    const batch = (data.channels || []) as SlackChannel[];
    channels.push(...batch);
    console.log(`[slack] Fetched ${batch.length} conversations (total: ${channels.length})`);
    cursor = data.response_metadata?.next_cursor || "";
    if (!cursor || batch.length === 0) break;
  }
  return channels.slice(0, maxChannels);
}

interface SlackMessage {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  team?: string;
  files?: any[];
}

const SKIP_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
]);

async function fetchUnreadMessages(
  token: string,
  channelId: string,
  maxMessages: number,
): Promise<{ messages: SlackMessage[]; lastRead: string }> {
  // Get channel info to find last_read timestamp
  let lastRead = "0";
  try {
    const info = await slackApi(token, "conversations.info", { channel: channelId });
    lastRead = info.channel?.last_read || "0";
  } catch {
    // If we can't get last_read, fetch recent messages
  }

  const messages: SlackMessage[] = [];
  let cursor = "";
  while (messages.length < maxMessages) {
    const params: Record<string, string | number> = {
      channel: channelId,
      limit: Math.min(100, maxMessages - messages.length),
    };
    if (lastRead !== "0") params.oldest = lastRead;
    if (cursor) params.cursor = cursor;

    const data = await slackApi(token, "conversations.history", params);
    const batch = ((data.messages || []) as SlackMessage[]).filter(
      (m) => !m.subtype || !SKIP_SUBTYPES.has(m.subtype),
    );
    messages.push(...batch);
    cursor = data.response_metadata?.next_cursor || "";
    if (!cursor || !data.has_more || batch.length === 0) break;
  }
  return { messages: messages.slice(0, maxMessages), lastRead };
}

async function markChannelRead(
  token: string,
  channelId: string,
  latestTs: string,
): Promise<boolean> {
  try {
    await slackApi(token, "conversations.mark", {
      channel: channelId,
      ts: latestTs,
    });
    return true;
  } catch (e: any) {
    console.error(`[slack] Failed to mark ${channelId} read: ${e.message?.slice(0, 100)}`);
    return false;
  }
}

// ── Channel name formatting ──

async function formatSubject(
  token: string,
  channel: SlackChannel,
): Promise<string> {
  if (channel.is_im && channel.user) {
    const name = await resolveUserName(token, channel.user);
    return `DM:${name}`;
  }
  if (channel.is_mpim) {
    return `Group:${channel.name}`;
  }
  return `#${channel.name}`;
}

// ── Inline classification via claude -p (Layer 2) ──

interface Classification {
  action: "NOTIFY" | "QUEUE" | "AUTO";
  urgency: string;
  summary: string;
  reasoning: string;
  domain: string;
}

function classifyMessage(
  subject: string,
  sender: string,
  preview: string,
): Classification {
  const content = `Channel: ${subject}\nFrom: ${sender}\n\n${preview}`.slice(0, 2000);
  const prompt = `You are a Slack message triage system. Classify this message.

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
- NOTIFY: Security alerts, service down, P1 incidents, direct requests needing immediate attention
- QUEUE: New tickets, feature requests, non-urgent tasks — add to workstream for later
- AUTO: Bot notifications, resolved alerts, routine updates, general chatter — log and move on
- critical/high -> NOTIFY, medium -> QUEUE or AUTO, low -> AUTO`;

  try {
    const tmpFile = `/tmp/batch-classify-slack-${Date.now()}.txt`;
    writeFileSync(tmpFile, prompt);
    const result = execSync(
      `cat ${tmpFile} | claude -p 2>/dev/null`,
      { encoding: "utf-8", timeout: 60000 },
    ).trim();
    try { unlinkSync(tmpFile); } catch { /* best-effort */ }

    const jsonStart = result.indexOf("{");
    const jsonEnd = result.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      throw new Error(`No JSON object found in response: ${result.slice(0, 100)}`);
    }
    const inner = JSON.parse(result.slice(jsonStart, jsonEnd + 1));
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

  // Layer 1b: Rules — glob pattern match with source="slack"
  if (cacheLib) {
    try {
      const rule = cacheLib.matchRule("slack", sender, subject);
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
  const aiResult = classifyMessage(subject, sender, preview);
  return {
    ...aiResult,
    classified_by: "L2_ai",
    rule_id: null,
  };
}

// ── Main ──

export async function main(
  max_channels: number = 100,
  max_messages_per_channel: number = 50,
  delay_ms: number = 2000,
  dry_run: boolean = false,
  channel_filter: string = "",
): Promise<{
  total_channels: number;
  channels_with_unread: number;
  total_messages: number;
  triaged: number;
  auto_count: number;
  queue_count: number;
  notify_count: number;
  errors: number;
  channels_marked_read: number;
  layer_breakdown: { l1_rule: number; l1_dedup: number; l2_ai: number };
  results: Array<{
    channel: string;
    sender: string;
    action: string;
    urgency: string;
    summary: string;
    classified_by: string;
  }>;
}> {
  const startTime = Date.now();
  console.log(`[batch_triage_slack] Starting: max_channels=${max_channels}, max_messages=${max_messages_per_channel}, dry_run=${dry_run}`);

  // Try to load cache_lib for L1 layers — gracefully degrade if unavailable
  let cacheLib: any = null;
  try {
    cacheLib = await import("./cache_lib.ts");
    if (cacheLib.isAvailable()) {
      cacheLib.init();
      console.log("[batch_triage_slack] Cache lib loaded — L1 layers active");
    } else {
      console.log("[batch_triage_slack] Cache not available — L1 layers disabled, L2 only");
      cacheLib = null;
    }
  } catch (e: any) {
    console.log(`[batch_triage_slack] Cache lib not loaded: ${e.message?.slice(0, 100)} — L2 only`);
    cacheLib = null;
  }

  // Get Slack bot token
  let slackToken: string;
  try {
    slackToken = await getSlackToken();
    console.log("[batch_triage_slack] Slack API authenticated");
  } catch (err: any) {
    console.error(`[batch_triage_slack] Auth failed: ${err.message}`);
    return {
      total_channels: 0, channels_with_unread: 0, total_messages: 0,
      triaged: 0, auto_count: 0, queue_count: 0, notify_count: 0,
      errors: 1, channels_marked_read: 0,
      layer_breakdown: { l1_rule: 0, l1_dedup: 0, l2_ai: 0 },
      results: [],
    };
  }

  // Fetch all conversations the bot is in
  let channels: SlackChannel[];
  try {
    channels = await fetchAllConversations(slackToken, max_channels);
    console.log(`[batch_triage_slack] Found ${channels.length} conversations`);
  } catch (err: any) {
    console.error(`[batch_triage_slack] Failed to list conversations: ${err.message}`);
    return {
      total_channels: 0, channels_with_unread: 0, total_messages: 0,
      triaged: 0, auto_count: 0, queue_count: 0, notify_count: 0,
      errors: 1, channels_marked_read: 0,
      layer_breakdown: { l1_rule: 0, l1_dedup: 0, l2_ai: 0 },
      results: [],
    };
  }

  // Apply channel filter if specified
  if (channel_filter) {
    const filterLower = channel_filter.toLowerCase();
    channels = channels.filter(
      (ch) => ch.name?.toLowerCase().includes(filterLower) || ch.id === channel_filter,
    );
    console.log(`[batch_triage_slack] Filtered to ${channels.length} channels matching "${channel_filter}"`);
  }

  const results: Array<{
    channel: string; sender: string; action: string;
    urgency: string; summary: string; classified_by: string;
  }> = [];
  let autoCount = 0, queueCount = 0, notifyCount = 0, errorCount = 0;
  let channelsWithUnread = 0, channelsMarkedRead = 0, totalMessages = 0;
  const layerBreakdown = { l1_rule: 0, l1_dedup: 0, l2_ai: 0 };
  let lastWasAi = false;

  for (let ci = 0; ci < channels.length; ci++) {
    const channel = channels[ci];
    const channelSubject = await formatSubject(slackToken, channel);
    console.log(`\n[batch_triage_slack] [${ci + 1}/${channels.length}] Processing: ${channelSubject}`);

    // Rate limit between channel API calls
    if (ci > 0 && delay_ms > 0) {
      await new Promise((r) => setTimeout(r, delay_ms));
    }

    // Fetch unread messages for this channel
    let messages: SlackMessage[];
    let lastRead: string;
    try {
      const result = await fetchUnreadMessages(slackToken, channel.id, max_messages_per_channel);
      messages = result.messages;
      lastRead = result.lastRead;
    } catch (err: any) {
      console.error(`[batch_triage_slack] Failed to fetch messages for ${channelSubject}: ${err.message?.slice(0, 200)}`);
      errorCount++;
      continue;
    }

    if (messages.length === 0) {
      continue;
    }

    channelsWithUnread++;
    totalMessages += messages.length;
    console.log(`[batch_triage_slack] ${messages.length} unread messages in ${channelSubject}`);

    let latestTs = lastRead;

    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];

      // Track latest ts for conversations.mark
      if (msg.ts > latestTs) latestTs = msg.ts;

      // Resolve sender
      const userId = msg.user || msg.bot_id || "unknown";
      const userName = msg.user
        ? await resolveUserName(slackToken, msg.user)
        : (msg.bot_id ? `bot:${msg.bot_id}` : "unknown");
      const sender = `${userName} <${userId}>`;

      const preview = (msg.text || "").slice(0, 500);
      const messageId = `${channel.id}:${msg.ts}`;
      const receivedAt = new Date(parseFloat(msg.ts) * 1000).toISOString();

      console.log(`[batch_triage_slack] [${ci + 1}/${channels.length}][${mi + 1}/${messages.length}] Triaging: ${sender.slice(0, 40)} in ${channelSubject}`);

      // Only delay before L2 AI calls (not L1)
      if (lastWasAi && delay_ms > 0) {
        await new Promise((r) => setTimeout(r, delay_ms));
      }

      try {
        const classification = classifyLayered(
          messageId, channelSubject, sender, preview, receivedAt, cacheLib,
        );
        lastWasAi = classification.classified_by === "L2_ai";

        // Track layer breakdown
        if (classification.classified_by === "L1_rule") layerBreakdown.l1_rule++;
        else if (classification.classified_by === "L1_dedup") layerBreakdown.l1_dedup++;
        else layerBreakdown.l2_ai++;

        results.push({
          channel: channelSubject,
          sender: sender.slice(0, 100),
          action: classification.action,
          urgency: classification.urgency,
          summary: classification.summary,
          classified_by: classification.classified_by,
        });

        // Store result in triage_results
        if (cacheLib) {
          try {
            const dedupHash = computeDedupHash(channelSubject, sender);
            cacheLib.storeTriageResult({
              source: "slack",
              message_id: messageId,
              subject: channelSubject,
              sender,
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
              metadata: JSON.stringify({
                channel_id: channel.id,
                channel_type: channel.is_im ? "im" : channel.is_mpim ? "mpim" : channel.is_group ? "group" : "channel",
                thread_ts: msg.thread_ts || null,
                team: msg.team || null,
                preview: msg.text?.slice(0, 1000) || "",
              }),
            });
          } catch { /* best-effort storage */ }
        }

        switch (classification.action) {
          case "AUTO": autoCount++; break;
          case "QUEUE": queueCount++; break;
          case "NOTIFY": notifyCount++; break;
        }

        console.log(`[batch_triage_slack] → ${classification.action} (${classification.urgency}) [${classification.classified_by}]: ${classification.summary.slice(0, 80)}`);
      } catch (err: any) {
        errorCount++;
        lastWasAi = false;
        console.error(`[batch_triage_slack] Error: ${err.message?.slice(0, 200)}`);
        results.push({
          channel: channelSubject,
          sender: sender.slice(0, 100),
          action: "ERROR",
          urgency: "unknown",
          summary: err.message?.slice(0, 200) || "Unknown error",
          classified_by: "error",
        });
      }
    }

    // Mark channel as read (advance cursor to latest processed message)
    if (!dry_run && latestTs > lastRead) {
      const marked = await markChannelRead(slackToken, channel.id, latestTs);
      if (marked) channelsMarkedRead++;
    }
  }

  const duration = Date.now() - startTime;
  console.log(`\n[batch_triage_slack] Complete in ${(duration / 1000).toFixed(1)}s`);
  console.log(`[batch_triage_slack] Channels: ${channels.length} total, ${channelsWithUnread} with unread`);
  console.log(`[batch_triage_slack] Messages: ${totalMessages} total, ${autoCount} AUTO, ${queueCount} QUEUE, ${notifyCount} NOTIFY, ${errorCount} errors`);
  console.log(`[batch_triage_slack] Layers: ${layerBreakdown.l1_dedup} dedup, ${layerBreakdown.l1_rule} rule, ${layerBreakdown.l2_ai} AI`);
  if (!dry_run) console.log(`[batch_triage_slack] Channels marked read: ${channelsMarkedRead}`);

  return {
    total_channels: channels.length,
    channels_with_unread: channelsWithUnread,
    total_messages: totalMessages,
    triaged: totalMessages - errorCount,
    auto_count: autoCount,
    queue_count: queueCount,
    notify_count: notifyCount,
    errors: errorCount,
    channels_marked_read: channelsMarkedRead,
    layer_breakdown: layerBreakdown,
    results,
  };
}
