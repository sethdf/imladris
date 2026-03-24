// Windmill Script: Batch Triage Slack Messages
// Pipeline: dedup → AI classification (Haiku) → store results.
// Mirrors batch_triage_emails.ts structure for Slack conversations.
// Thread-as-unit: threads are treated as single triage items with full reply context.

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

async function fetchThreadReplies(
  token: string,
  channelId: string,
  threadTs: string,
  maxReplies: number = 50,
): Promise<SlackMessage[]> {
  const replies: SlackMessage[] = [];
  let cursor = "";
  while (replies.length < maxReplies) {
    const params: Record<string, string | number> = {
      channel: channelId,
      ts: threadTs,
      limit: Math.min(100, maxReplies - replies.length),
    };
    if (cursor) params.cursor = cursor;

    const data = await slackApi(token, "conversations.replies", params);
    const batch = ((data.messages || []) as SlackMessage[]).filter(
      (m) => !m.subtype || !SKIP_SUBTYPES.has(m.subtype),
    );
    // First message in replies is the parent — skip it (we already have it)
    const replyOnly = batch.filter((m) => m.ts !== threadTs);
    replies.push(...replyOnly);
    cursor = data.response_metadata?.next_cursor || "";
    if (!cursor || !data.has_more || batch.length === 0) break;
  }
  return replies.slice(0, maxReplies);
}

async function buildThreadBody(
  token: string,
  channelId: string,
  parentMsg: SlackMessage,
  maxChars: number = 4000,
): Promise<string> {
  const parts: string[] = [];
  // Parent message
  const parentUser = parentMsg.user
    ? await resolveUserName(token, parentMsg.user)
    : (parentMsg.bot_id ? `bot:${parentMsg.bot_id}` : "unknown");
  parts.push(`[${parentUser}] ${parentMsg.text || ""}`);

  // Fetch thread replies
  if (parentMsg.thread_ts && parentMsg.thread_ts === parentMsg.ts) {
    try {
      const replies = await fetchThreadReplies(token, channelId, parentMsg.thread_ts);
      for (const reply of replies) {
        const replyUser = reply.user
          ? await resolveUserName(token, reply.user)
          : (reply.bot_id ? `bot:${reply.bot_id}` : "unknown");
        parts.push(`[${replyUser}] ${reply.text || ""}`);
      }
    } catch (err: any) {
      console.error(`[slack] Failed to fetch thread replies: ${err.message?.slice(0, 100)}`);
    }
  }

  return parts.join("\n").slice(0, maxChars);
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

async function classifyMessage(
  subject: string,
  sender: string,
  preview: string,
  recentContext: string,
): Promise<Classification> {
  const content = `Channel: ${subject}\nFrom: ${sender}\n\n${preview}`.slice(0, 2000);
  const contextBlock = recentContext
    ? `\nRecent history for this sender/channel:\n${recentContext}\n\nConsider whether this message represents an escalation, new pattern, or continuation of the above.\n`
    : "";
  const prompt = `You are a Slack message triage system. Classify this message and extract structured metadata.
${contextBlock}
${content}

Respond with ONLY valid JSON (no markdown):
{
  "action": "NOTIFY|QUEUE|AUTO",
  "urgency": "critical|high|medium|low",
  "summary": "one sentence summary",
  "reasoning": "why this classification",
  "domain": "work|personal",
  "entities": ["lowercase server/service/system names mentioned"],
  "alert_type": "outage|security|access|change|license|info",
  "source_system": "name of the monitoring/alerting tool, or empty string",
  "is_resolution": false
}

Rules:
- NOTIFY: Security alerts, service down, P1 incidents, direct requests needing immediate attention
- QUEUE: New tickets, feature requests, non-urgent tasks — add to workstream for later
- AUTO: Bot notifications, resolved alerts, routine updates, general chatter — log and move on
- critical/high -> NOTIFY, medium -> QUEUE or AUTO, low -> AUTO
- entities: extract all server names, service names, system names as lowercase. Omit generic words.
- alert_type: outage (down/up), security (DLP/breach/vulnerability), access (permissions/consent), change (config/deploy), license (renewal/expiry), info (newsletter/digest/report)
- is_resolution: true ONLY if this message indicates a problem is resolved`;

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

/** Strip monitoring-specific variable parts so repeated alerts collapse to one hash */
function normalizeSubject(subject: string): string {
  let s = subject;
  s = s.replace(/\s+for\s+\d+\s*(?:Min|Sec|Hour|Day)s?(?:\s+\d+\s*(?:Min|Sec|Hour|Day)s?)*/gi, "");
  return s.trim();
}

function computeDedupHash(subject: string, sender: string): string {
  const normalized = `${sender.toLowerCase().trim()}|${normalizeSubject(subject).toLowerCase()}`;
  return createHash("sha256").update(normalized).digest("hex");
}

interface ClassificationResult extends Classification {
  classified_by: string;
}

async function classifyWithContext(
  subject: string,
  sender: string,
  preview: string,
  cacheLib: any | null,
): Promise<ClassificationResult & { dedup_skipped?: boolean }> {
  if (cacheLib) {
    try {
      const dedupHash = computeDedupHash(subject, sender);
      const dedup = cacheLib.checkDedup(dedupHash);
      if (dedup.found && dedup.existing) {
        console.log(`[dedup] Skipping duplicate: "${subject.slice(0, 60)}..." (prev: ${dedup.existing.action})`);
        return {
          action: dedup.existing.action as "NOTIFY" | "QUEUE" | "AUTO",
          urgency: dedup.existing.urgency,
          summary: dedup.existing.summary,
          reasoning: dedup.existing.reasoning || "duplicate of previous classification",
          domain: dedup.existing.domain,
          entities: [],
          alert_type: "info",
          source_system: "",
          is_resolution: false,
          classified_by: "dedup",
          dedup_skipped: true,
        };
      }
    } catch { /* context is best-effort */ }
  }

  const aiResult = await classifyMessage(subject, sender, preview, "");
  return {
    ...aiResult,
    classified_by: "ai",
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
  dedup_skipped: number;
  layer_breakdown: { ai: number; dedup: number };
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
      console.log("[batch_triage_slack] Cache lib loaded — dedup active");
    } else {
      console.log("[batch_triage_slack] Cache not available — dedup disabled, AI only");
      cacheLib = null;
    }
  } catch (e: any) {
    console.log(`[batch_triage_slack] Cache lib not loaded: ${e.message?.slice(0, 100)} — AI only`);
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
      dedup_skipped: 0, layer_breakdown: { ai: 0, dedup: 0 },
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
      dedup_skipped: 0, layer_breakdown: { ai: 0, dedup: 0 },
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
  let dedupSkipCount = 0;
  const layerBreakdown = { ai: 0, dedup: 0 };

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

    // Group messages by thread: thread_ts → parent message
    // Standalone messages (no thread_ts or thread_ts === ts) are their own unit
    const threadMap = new Map<string, SlackMessage>();
    for (const msg of messages) {
      if (msg.ts > latestTs) latestTs = msg.ts;
      const threadKey = msg.thread_ts || msg.ts;
      // Keep the earliest (parent) message per thread
      if (!threadMap.has(threadKey) || msg.ts < threadMap.get(threadKey)!.ts) {
        threadMap.set(threadKey, msg);
      }
    }

    const threadUnits = Array.from(threadMap.entries());
    console.log(`[batch_triage_slack] ${threadUnits.length} thread units (from ${messages.length} messages)`);

    for (let mi = 0; mi < threadUnits.length; mi++) {
      const [threadKey, parentMsg] = threadUnits[mi];

      // Resolve sender (parent message author)
      const userId = parentMsg.user || parentMsg.bot_id || "unknown";
      const userName = parentMsg.user
        ? await resolveUserName(slackToken, parentMsg.user)
        : (parentMsg.bot_id ? `bot:${parentMsg.bot_id}` : "unknown");
      const sender = `${userName} <${userId}>`;

      // Build full thread body (parent + all replies)
      const threadBody = await buildThreadBody(slackToken, channel.id, parentMsg);
      const preview = threadBody.slice(0, 500);
      const messageId = `${channel.id}:${threadKey}`;
      const receivedAt = new Date(parseFloat(parentMsg.ts) * 1000).toISOString();

      console.log(`[batch_triage_slack] [${ci + 1}/${channels.length}][${mi + 1}/${threadUnits.length}] Triaging thread: ${sender.slice(0, 40)} in ${channelSubject}`);

      try {
        const classification = await classifyWithContext(channelSubject, sender, preview, cacheLib);

        if (classification.dedup_skipped) {
          dedupSkipCount++;
          layerBreakdown.dedup++;
          results.push({
            channel: channelSubject, sender: sender.slice(0, 100),
            action: classification.action, urgency: classification.urgency,
            summary: `[dedup] ${classification.summary}`, classified_by: "dedup",
          });
          if (classification.action === "AUTO") autoCount++;
          else if (classification.action === "QUEUE") queueCount++;
          else if (classification.action === "NOTIFY") notifyCount++;
          console.log(`[batch_triage_slack] → ${classification.action} [dedup skip]`);
          continue;
        }

        // Delay before AI calls
        if (mi > 0 && delay_ms > 0) {
          await new Promise((r) => setTimeout(r, delay_ms));
        }
        layerBreakdown.ai++;

        results.push({
          channel: channelSubject,
          sender: sender.slice(0, 100),
          action: classification.action,
          urgency: classification.urgency,
          summary: classification.summary,
          classified_by: classification.classified_by,
        });

        // Store result in triage_results (only for new classifications)
        if (cacheLib) {
          try {
            const dedupHash = computeDedupHash(`${channel.id}:${threadKey}`, sender);
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
              dedup_hash: dedupHash,
              marked_read: 0,
              metadata: JSON.stringify({
                channel_id: channel.id,
                channel_type: channel.is_im ? "im" : channel.is_mpim ? "mpim" : channel.is_group ? "group" : "channel",
                thread_ts: threadKey,
                team: parentMsg.team || null,
                body_text: threadBody.slice(0, 8000),
                preview: preview,
                is_resolution: classification.is_resolution,
              }),
              entities: JSON.stringify(classification.entities),
              alert_type: classification.alert_type,
              source_system: classification.source_system,
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
  console.log(`[batch_triage_slack] AI: ${layerBreakdown.ai}, Dedup skipped: ${layerBreakdown.dedup}`);
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
    dedup_skipped: dedupSkipCount,
    layer_breakdown: layerBreakdown,
    results,
  };
}
