// Windmill Script: Approve and Execute Remediation
// Seth runs this to approve a pending remediation. Pipeline:
//   1. Validate remediation exists and is pending
//   2. For automated: validate commands (aws/az only), execute, verify
//   3. For manual: acknowledge (no execution)
//   4. Record outcome for feedback loop
//   5. Post Slack confirmation
//
// CRITICAL: This is the ONLY path to execute write actions.
// Safety boundary: only aws/az CLI commands allowed for automated execution.

import { execSync } from "child_process";

// ── Windmill helpers ──

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
  } catch { return undefined; }
}

async function runWindmillScript(path: string, args: Record<string, unknown>): Promise<{ success: boolean; result?: any; error?: string }> {
  if (!WM_TOKEN) return { success: false, error: "No WM_TOKEN" };
  try {
    const resp = await fetch(
      `${WM_BASE}/api/w/${WM_WORKSPACE}/jobs/run_wait_result/p/${path}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${WM_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { success: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
    }
    const result = await resp.json();
    if (result?.error) return { success: false, result, error: result.error };
    return { success: true, result };
  } catch (err: any) {
    return { success: false, error: err.message?.slice(0, 300) };
  }
}

async function postSlack(channel: string, text: string, blocks?: any[]): Promise<{ ok: boolean; ts?: string }> {
  const token = await getVariable("f/devops/slack_user_token");
  if (!token) return { ok: false };
  try {
    const body: any = { channel, text };
    if (blocks) body.blocks = blocks;
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    return { ok: data.ok, ts: data.ts };
  } catch { return { ok: false }; }
}

// ── Safety: only aws/az CLI commands allowed ──

const ALLOWED_PREFIXES = ["aws ", "az "];

function isCommandSafe(cmd: string): boolean {
  const trimmed = cmd.trim();
  return ALLOWED_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

function executeCommand(cmd: string): { success: boolean; output: string; error?: string } {
  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 60000 }).trim();
    return { success: true, output };
  } catch (e: unknown) {
    const err = e as Error & { stderr?: string };
    return { success: false, output: "", error: err.stderr || err.message || String(e) };
  }
}

// ── Main ──

export async function main(
  remediation_id: string,
  action: string = "approve",
  rating: number = 0,
  rating_notes: string = "",
): Promise<{
  success: boolean;
  remediation_id: string;
  action: string;
  execution_results?: any[];
  verification_result?: any;
  rollback_info?: string;
  error?: string;
}> {
  if (!remediation_id) {
    return { success: false, remediation_id: "", action, error: "remediation_id is required" };
  }

  // Load cache
  let cacheLib: any;
  try {
    cacheLib = await import("./cache_lib.ts");
    cacheLib.init();
  } catch (err: any) {
    return { success: false, remediation_id, action, error: `Cache unavailable: ${err.message}` };
  }

  // Handle rating action (post-execution feedback)
  if (action === "rate") {
    if (rating < 1 || rating > 5) {
      return { success: false, remediation_id, action, error: "Rating must be 1-5" };
    }
    const rated = cacheLib.rateRemediation(remediation_id, rating, rating_notes);
    return { success: rated, remediation_id, action: "rated", error: rated ? undefined : "Failed to record rating" };
  }

  // Get the pending remediation
  const rem = cacheLib.getPendingRemediation(remediation_id);
  if (!rem) {
    return { success: false, remediation_id, action, error: "Remediation not found" };
  }
  if (rem.status !== "pending") {
    return { success: false, remediation_id, action, error: `Remediation is ${rem.status}, not pending` };
  }

  const remDescription = rem.description || rem.playbook || "unknown action";
  const actionType = rem.action_type || "automated";

  // Handle rejection
  if (action === "reject") {
    cacheLib.updateRemediationStatus(remediation_id, "rejected");
    console.log(`[approve_remediation] Rejected: ${remediation_id}`);

    // Record outcome (rejected = not executed)
    cacheLib.recordRemediationOutcome({
      remediation_id, dedup_hash: rem.dedup_hash,
      action_type: actionType, description: remDescription,
      target_resource: rem.target_resource, commands_executed: [],
      execution_success: false, execution_output: "Rejected by operator",
      alert_domain: "", alert_type: "",
    });

    if (rem.slack_channel) {
      await postSlack(rem.slack_channel,
        `Remediation ${remediation_id} REJECTED. No action taken.`,
        [{
          type: "section",
          text: { type: "mrkdwn", text: `*Remediation Rejected*\n${remDescription} on \`${rem.target_resource}\` — no action taken.` },
        }],
      );
    }

    return { success: true, remediation_id, action: "rejected", rollback_info: "No action was taken — nothing to roll back." };
  }

  // ── APPROVE + EXECUTE ──
  console.log(`[approve_remediation] Approving: ${remediation_id} — ${remDescription} on ${rem.target_resource}`);
  cacheLib.updateRemediationStatus(remediation_id, "approved");

  // ── Handle MANUAL action type ──
  if (actionType === "manual") {
    console.log(`[approve_remediation] Manual remediation acknowledged: ${remediation_id}`);
    cacheLib.updateRemediationStatus(remediation_id, "executed", {
      execution_result: JSON.stringify({ type: "manual", acknowledged: true }),
    });

    cacheLib.recordRemediationOutcome({
      remediation_id, dedup_hash: rem.dedup_hash,
      action_type: "manual", description: remDescription,
      target_resource: rem.target_resource, commands_executed: [],
      execution_success: true, execution_output: "Manual remediation acknowledged",
      alert_domain: "", alert_type: "",
    });

    if (rem.slack_channel) {
      await postSlack(rem.slack_channel,
        `Manual remediation ${remediation_id} acknowledged.`,
        [{
          type: "section",
          text: { type: "mrkdwn", text: `*Manual Remediation Acknowledged*\n${remDescription}\n\nTarget: \`${rem.target_resource}\`\nAction items have been noted. Follow up as needed.` },
        }],
      );
    }

    return { success: true, remediation_id, action: "acknowledged", rollback_info: rem.rollback_plan };
  }

  // ── Handle AUTOMATED action type ──
  let commands: string[] = [];
  try {
    commands = JSON.parse(rem.commands || "[]");
  } catch {
    commands = [];
  }

  let rollbackCommands: string[] = [];
  try {
    rollbackCommands = JSON.parse(rem.rollback_commands || "[]");
  } catch {
    rollbackCommands = [];
  }

  if (commands.length === 0) {
    const errMsg = "No commands to execute";
    cacheLib.updateRemediationStatus(remediation_id, "failed", {
      execution_result: JSON.stringify({ error: errMsg }),
    });
    return { success: false, remediation_id, action: "executed", error: errMsg };
  }

  // Safety check: validate all commands before executing any
  const unsafeCommands = commands.filter(cmd => !isCommandSafe(cmd));
  if (unsafeCommands.length > 0) {
    const errMsg = `Safety boundary: only aws/az CLI commands allowed. Rejected: ${unsafeCommands.join("; ")}`;
    cacheLib.updateRemediationStatus(remediation_id, "failed", {
      execution_result: JSON.stringify({ error: errMsg, rejected_commands: unsafeCommands }),
    });

    cacheLib.recordRemediationOutcome({
      remediation_id, dedup_hash: rem.dedup_hash,
      action_type: "automated", description: remDescription,
      target_resource: rem.target_resource, commands_executed: [],
      execution_success: false, execution_output: errMsg,
      alert_domain: "", alert_type: "",
    });

    return { success: false, remediation_id, action: "executed", error: errMsg };
  }

  // Execute commands sequentially
  console.log(`[approve_remediation] Executing ${commands.length} commands`);
  const executionResults: Array<{ command: string; success: boolean; output: string; error?: string }> = [];
  let allSucceeded = true;

  for (const cmd of commands) {
    console.log(`[approve_remediation] Running: ${cmd}`);
    const result = executeCommand(cmd);
    executionResults.push({ command: cmd, ...result });
    if (!result.success) {
      allSucceeded = false;
      console.error(`[approve_remediation] Command failed: ${result.error}`);
      break; // Stop on first failure
    }
  }

  const executionOutput = executionResults.map(r =>
    r.success ? `OK: ${r.command} → ${r.output.slice(0, 200)}` : `FAIL: ${r.command} → ${r.error?.slice(0, 200)}`
  ).join("\n");

  if (!allSucceeded) {
    cacheLib.updateRemediationStatus(remediation_id, "failed", {
      execution_result: JSON.stringify(executionResults),
    });

    cacheLib.recordRemediationOutcome({
      remediation_id, dedup_hash: rem.dedup_hash,
      action_type: "automated", description: remDescription,
      target_resource: rem.target_resource,
      commands_executed: executionResults.filter(r => r.success).map(r => r.command),
      execution_success: false, execution_output: executionOutput,
      alert_domain: "", alert_type: "",
    });

    const rollbackInfo = rollbackCommands.length > 0
      ? `Rollback commands:\n${rollbackCommands.join("\n")}`
      : rem.rollback_plan;

    if (rem.slack_channel) {
      await postSlack(rem.slack_channel,
        `Remediation ${remediation_id} FAILED`,
        [{
          type: "section",
          text: { type: "mrkdwn", text: `*Remediation Failed*\n${remDescription} on \`${rem.target_resource}\`\n\n${executionOutput}\n\n*Rollback:* ${rollbackInfo}` },
        }],
      );
    }

    return {
      success: false, remediation_id, action: "executed",
      execution_results: executionResults,
      rollback_info: rollbackInfo,
      error: executionResults.find(r => !r.success)?.error || "Command failed",
    };
  }

  // All commands succeeded
  console.log(`[approve_remediation] All commands succeeded. Running verification...`);
  cacheLib.updateRemediationStatus(remediation_id, "executed", {
    execution_result: JSON.stringify(executionResults),
  });

  // Verify (best-effort)
  let verificationResult: any = null;
  try {
    const verifyResp = await runWindmillScript("f/devops/verify_remediation", {
      item_id: rem.dedup_hash,
      original_investigation: JSON.stringify({
        entities: [{ value: rem.target_resource, type: guessEntityType(rem.target_resource) }],
        evidence: [],
        diagnosis: { summary: rem.diagnosis_summary, severity: rem.severity },
      }),
      playbook_result: JSON.stringify({ success: true, output: executionOutput }),
      approval_id: remediation_id,
    });

    if (verifyResp.success) {
      verificationResult = verifyResp.result;
      cacheLib.updateRemediationStatus(remediation_id, "verified", {
        verification_result: JSON.stringify(verificationResult),
      });
    }
  } catch (err: any) {
    console.warn(`[approve_remediation] Verification failed (non-fatal): ${err.message}`);
  }

  // Record outcome
  cacheLib.recordRemediationOutcome({
    remediation_id, dedup_hash: rem.dedup_hash,
    action_type: "automated", description: remDescription,
    target_resource: rem.target_resource,
    commands_executed: commands,
    execution_success: true, execution_output: executionOutput,
    verified: verificationResult?.verified,
    verification_summary: verificationResult?.summary || "",
    alert_domain: "", alert_type: "",
  });

  // Post Slack confirmation
  const verified = verificationResult?.verified;
  const verifyEmoji = verified === true ? "white_check_mark" : verified === false ? "warning" : "question";
  const statusText = verified === true ? "Verified" : verified === false ? "Needs Review" : "Verification Skipped";

  const rollbackInfo = rollbackCommands.length > 0
    ? `Rollback commands:\n${rollbackCommands.map(c => `\`${c}\``).join("\n")}`
    : rem.rollback_plan;

  if (rem.slack_channel) {
    const blocks: any[] = [
      {
        type: "header",
        text: { type: "plain_text", text: `Remediation Complete — ${statusText}` },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*Action:* ${remDescription}`,
            `*Target:* \`${rem.target_resource}\``,
            `*Commands:* ${commands.length} executed successfully`,
            verified !== undefined ? `*Verification:* :${verifyEmoji}: ${verificationResult?.summary || statusText}` : "",
            `*Rollback:* ${rollbackInfo}`,
            rem.sdp_link ? `*SDP:* <${rem.sdp_link}|View Task>` : "",
            `\nTo rate this remediation: run \`approve_remediation\` with \`remediation_id: ${remediation_id}, action: rate, rating: 1-5\``,
          ].filter(Boolean).join("\n"),
        },
      },
    ];

    await postSlack(rem.slack_channel, `Remediation ${remediation_id} complete: ${statusText}`, blocks);
  }

  return {
    success: true,
    remediation_id,
    action: "executed",
    execution_results: executionResults,
    verification_result: verificationResult,
    rollback_info: rollbackInfo,
  };
}

function guessEntityType(resource: string): string {
  if (resource.startsWith("i-")) return "ec2_instance";
  if (resource.startsWith("sg-")) return "security_group";
  if (resource.startsWith("vol-")) return "volume";
  if (resource.startsWith("AKIA") || resource.startsWith("ASIA")) return "access_key";
  return "unknown";
}
