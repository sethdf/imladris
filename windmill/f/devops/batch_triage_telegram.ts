// Windmill Script: Batch Triage Telegram Messages
// Pipeline: fetch from whitelisted chats → dedup → AI classification (Haiku) → store results.
// Only monitors specific chats. Skips Seth's own messages.
// Tracks last processed message ID per chat to avoid reprocessing.

import { createHash } from "crypto";
import { bedrockInvoke, MODELS } from "./bedrock.ts";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

// ── Configuration ──

// Whitelisted chat IDs — ONLY these chats are triaged
const WHITELISTED_CHATS: Record<string, string> = {
  "996028622": "Kenan Clay",         // DM with kclay
  "-774808323": "Buxton DB",         // Group: kclay + Jordan St. Clair
};

// Seth's Telegram user ID — skip his own messages
const SELF_USER_ID = "812853473";

// State variable path in Windmill — stores {chatId: lastMsgId} JSON
const STATE_VAR_PATH = "f/devops/telegram_triage_state";

// ── Windmill variable helper ──

const WM_BASE = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
const WM_TOKEN = process.env.WM_TOKEN;
const WM_WORKSPACE = process.env.WM_WORKSPACE || "imladris";

async function getVariable(path: string): Promise<string | undefined> {
  if (!WM_TOKEN) return undefined;
  try {
    const resp = await fetch(
      `${WM_BASE}/api/w/${WM_WORKSPACE}/variables/get_value/${path}`,
      { headers: { Authorization: `Bearer ${WM_TOKEN}` } },
    );
    if (!resp.ok) return undefined;
    const val = await resp.text();
    const parsed = val.startsWith('"') ? JSON.parse(val) : val;
    return parsed.trim();
  } catch {
    return undefined;
  }
}

async function setVariable(path: string, value: string, isSecret: boolean = false): Promise<boolean> {
  if (!WM_TOKEN) return false;
  try {
    // Try update first
    const updateResp = await fetch(
      `${WM_BASE}/api/w/${WM_WORKSPACE}/variables/update/${path}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${WM_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      },
    );
    if (updateResp.ok) return true;

    // If not found, create
    const createResp = await fetch(
      `${WM_BASE}/api/w/${WM_WORKSPACE}/variables/create`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${WM_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path, value, is_secret: isSecret, description: "Telegram triage state: last processed message ID per chat" }),
      },
    );
    return createResp.ok;
  } catch {
    return false;
  }
}

// ── Telegram connection (inline — avoids cross-folder import) ──

async function connectTelegram(): Promise<TelegramClient> {
  const apiId = parseInt(await getVariable("f/investigate/telegram_api_id") || "0");
  const apiHash = await getVariable("f/investigate/telegram_api_hash") || "";
  const sessionStr = await getVariable("f/investigate/telegram_session") || "";

  if (!apiId || !apiHash || !sessionStr) {
    throw new Error("Telegram credentials not configured (api_id, api_hash, session)");
  }

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  return client;
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
}

async function classifyMessage(
  chatName: string,
  sender: string,
  text: string,
): Promise<Classification> {
  const content = `Chat: ${chatName}\nFrom: ${sender}\n\n${text}`.slice(0, 2000);
  const prompt = `You are a Telegram message triage system for IT operations. Classify this message and extract structured metadata.

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
  "source_system": "name of system referenced or empty string"
}

Rules:
- These messages are from IT staff (DBA, sysadmin). Context is always IT operations.
- NOTIFY: Urgent issues, outages, database problems, security alerts, direct requests needing immediate action
- QUEUE: Tasks, questions, non-urgent requests — add to workstream for later
- AUTO: Small talk, acknowledgments, "ok", "thanks" — log and move on
- critical/high -> NOTIFY, medium -> QUEUE or AUTO, low -> AUTO
- entities: extract all server names, database names, service names as lowercase
- alert_type: outage (down/up), security (breach/access), access (permissions), change (config/deploy), license (renewal), info (general)`;

  try {
    const result = await bedrockInvoke(prompt, {
      model: MODELS.HAIKU,
      maxTokens: 384,
      timeoutMs: 30000,
      parseJson: true,
    });

    const validActions = ["NOTIFY", "QUEUE", "AUTO"];
    if (!validActions.includes(result.action)) result.action = "QUEUE";
    if (!Array.isArray(result.entities)) result.entities = [];
    if (!result.alert_type) result.alert_type = "info";
    if (!result.source_system) result.source_system = "";
    return result as Classification;
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
    };
  }
}

// ── Helpers ──

function computeDedupHash(chatId: string, msgId: number, sender: string): string {
  const normalized = `telegram|${chatId}|${msgId}|${sender.toLowerCase().trim()}`;
  return createHash("sha256").update(normalized).digest("hex");
}

// ── Main ──

export async function main(
  max_messages_per_chat: number = 50,
  dry_run: boolean = false,
): Promise<{
  chats_checked: number;
  total_messages: number;
  triaged: number;
  skipped_self: number;
  auto_count: number;
  queue_count: number;
  notify_count: number;
  dedup_skipped: number;
  errors: number;
  results: Array<{
    chat: string;
    sender: string;
    action: string;
    urgency: string;
    summary: string;
  }>;
}> {
  const startTime = Date.now();
  console.log(`[batch_triage_telegram] Starting: chats=${Object.keys(WHITELISTED_CHATS).length}, max_per_chat=${max_messages_per_chat}, dry_run=${dry_run}`);

  // Load cache lib
  let cacheLib: any = null;
  try {
    cacheLib = await import("./cache_lib.ts");
    if (cacheLib.isAvailable()) {
      cacheLib.init();
      console.log("[batch_triage_telegram] Cache lib loaded — dedup active");
    } else {
      cacheLib = null;
    }
  } catch {
    cacheLib = null;
  }

  // Load state (last processed message ID per chat)
  let state: Record<string, number> = {};
  try {
    const stateJson = await getVariable(STATE_VAR_PATH);
    if (stateJson) state = JSON.parse(stateJson);
    console.log(`[batch_triage_telegram] State loaded: ${JSON.stringify(state)}`);
  } catch {
    console.log("[batch_triage_telegram] No prior state — processing all recent messages");
  }

  // Connect to Telegram
  let client: TelegramClient;
  try {
    client = await connectTelegram();
    console.log("[batch_triage_telegram] Telegram connected");
  } catch (err: any) {
    console.error(`[batch_triage_telegram] Connection failed: ${err.message}`);
    return {
      chats_checked: 0, total_messages: 0, triaged: 0, skipped_self: 0,
      auto_count: 0, queue_count: 0, notify_count: 0, dedup_skipped: 0,
      errors: 1, results: [],
    };
  }

  const results: Array<{
    chat: string; sender: string; action: string;
    urgency: string; summary: string;
  }> = [];
  let totalMessages = 0, skippedSelf = 0, errorCount = 0;
  let autoCount = 0, queueCount = 0, notifyCount = 0, dedupSkipped = 0;
  const newState: Record<string, number> = { ...state };

  try {
    for (const [chatId, chatName] of Object.entries(WHITELISTED_CHATS)) {
      console.log(`\n[batch_triage_telegram] Processing: ${chatName} (${chatId})`);

      const lastMsgId = state[chatId] || 0;
      const target = parseInt(chatId);

      // Fetch messages — iterMessages returns newest first
      const messages: Array<{
        id: number;
        date: number;
        senderId: string;
        senderName: string;
        text: string;
      }> = [];

      try {
        for await (const msg of client.iterMessages(target, { limit: max_messages_per_chat, minId: lastMsgId })) {
          // Resolve sender name
          let senderName = "unknown";
          let senderId = "";
          if (msg.sender) {
            const s = msg.sender as any;
            senderId = msg.senderId?.toString() || "";
            if (s.firstName || s.lastName) {
              senderName = [s.firstName, s.lastName].filter(Boolean).join(" ");
            } else if (s.title) {
              senderName = s.title;
            } else if (s.username) {
              senderName = `@${s.username}`;
            }
          }

          messages.push({
            id: msg.id,
            date: msg.date || 0,
            senderId,
            senderName,
            text: msg.text || "",
          });
        }
      } catch (err: any) {
        console.error(`[batch_triage_telegram] Failed to fetch messages from ${chatName}: ${err.message?.slice(0, 200)}`);
        errorCount++;
        continue;
      }

      // Sort oldest-first for processing order
      messages.sort((a, b) => a.id - b.id);
      totalMessages += messages.length;
      console.log(`[batch_triage_telegram] ${messages.length} new messages in ${chatName} (after msg ID ${lastMsgId})`);

      let highestMsgId = lastMsgId;

      for (const msg of messages) {
        if (msg.id > highestMsgId) highestMsgId = msg.id;

        // Skip Seth's own messages
        if (msg.senderId === SELF_USER_ID) {
          skippedSelf++;
          continue;
        }

        // Skip empty messages (media-only, etc.)
        if (!msg.text || msg.text.trim().length === 0) continue;

        // Dedup check
        if (cacheLib) {
          try {
            const dedupHash = computeDedupHash(chatId, msg.id, msg.senderName);
            const dedup = cacheLib.checkDedup(dedupHash);
            if (dedup.found) {
              dedupSkipped++;
              continue;
            }
          } catch { /* best-effort */ }
        }

        // Classify via Haiku
        const sender = `${msg.senderName}`;
        console.log(`[batch_triage_telegram] Classifying: [${chatName}] ${sender}: ${msg.text.slice(0, 60)}...`);

        try {
          const classification = await classifyMessage(chatName, sender, msg.text);
          const messageId = `${chatId}:${msg.id}`;
          const receivedAt = msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();

          results.push({
            chat: chatName,
            sender,
            action: classification.action,
            urgency: classification.urgency,
            summary: classification.summary,
          });

          // Store in triage_results
          if (cacheLib && !dry_run) {
            try {
              const dedupHash = computeDedupHash(chatId, msg.id, sender);
              cacheLib.storeTriageResult({
                source: "telegram",
                message_id: messageId,
                subject: `Telegram:${chatName}`,
                sender,
                received_at: receivedAt,
                action: classification.action,
                urgency: classification.urgency,
                summary: classification.summary,
                reasoning: classification.reasoning,
                domain: classification.domain,
                classified_by: "ai",
                dedup_hash: dedupHash,
                marked_read: 0,
                metadata: JSON.stringify({
                  chat_id: chatId,
                  chat_name: chatName,
                  msg_id: msg.id,
                  text: msg.text.slice(0, 8000),
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

          console.log(`[batch_triage_telegram] → ${classification.action} (${classification.urgency}): ${classification.summary.slice(0, 80)}`);
        } catch (err: any) {
          errorCount++;
          console.error(`[batch_triage_telegram] Classification error: ${err.message?.slice(0, 200)}`);
        }
      }

      newState[chatId] = highestMsgId;
    }

    // Save state (last processed message IDs)
    if (!dry_run) {
      const saved = await setVariable(STATE_VAR_PATH, JSON.stringify(newState));
      console.log(`[batch_triage_telegram] State saved: ${saved ? "ok" : "failed"} — ${JSON.stringify(newState)}`);
    }
  } finally {
    await client.disconnect();
  }

  const duration = Date.now() - startTime;
  console.log(`\n[batch_triage_telegram] Complete in ${(duration / 1000).toFixed(1)}s`);
  console.log(`[batch_triage_telegram] Messages: ${totalMessages} total, ${skippedSelf} self, ${dedupSkipped} dedup, ${errorCount} errors`);
  console.log(`[batch_triage_telegram] Triaged: ${autoCount} AUTO, ${queueCount} QUEUE, ${notifyCount} NOTIFY`);

  return {
    chats_checked: Object.keys(WHITELISTED_CHATS).length,
    total_messages: totalMessages,
    triaged: autoCount + queueCount + notifyCount,
    skipped_self: skippedSelf,
    auto_count: autoCount,
    queue_count: queueCount,
    notify_count: notifyCount,
    dedup_skipped: dedupSkipped,
    errors: errorCount,
    results,
  };
}
