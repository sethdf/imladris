// Windmill Script: Approve and Execute Remediation
// Seth runs this to approve a pending remediation. Pipeline:
//   1. Validate remediation exists and is pending
//   2. Capture pre-state (rollback snapshot)
//   3. Execute playbook via response_playbook
//   4. Verify via verify_remediation (before/after probes)
//   5. Update SDP task with results
//   6. Post Slack confirmation
//
// CRITICAL: This is the ONLY path to execute write actions.
// Every execution records pre-state for rollback.

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

// ── Main ──

export async function main(
  remediation_id: string,
  action: string = "approve",
): Promise<{
  success: boolean;
  remediation_id: string;
  action: string;
  playbook_result?: any;
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

  // Get the pending remediation
  const rem = cacheLib.getPendingRemediation(remediation_id);
  if (!rem) {
    return { success: false, remediation_id, action, error: "Remediation not found" };
  }
  if (rem.status !== "pending") {
    return { success: false, remediation_id, action, error: `Remediation is ${rem.status}, not pending` };
  }

  // Handle rejection
  if (action === "reject") {
    cacheLib.updateRemediationStatus(remediation_id, "rejected");
    console.log(`[approve_remediation] Rejected: ${remediation_id}`);

    // Notify Slack
    if (rem.slack_channel) {
      await postSlack(rem.slack_channel,
        `Remediation ${remediation_id} REJECTED. No action taken.`,
        [{
          type: "section",
          text: { type: "mrkdwn", text: `*Remediation Rejected*\n\`${rem.playbook}\` on \`${rem.target_resource}\` — no action taken.` },
        }],
      );
    }

    return { success: true, remediation_id, action: "rejected", rollback_info: "No action was taken — nothing to roll back." };
  }

  // ── APPROVE + EXECUTE ──
  console.log(`[approve_remediation] Approving: ${remediation_id} — ${rem.playbook} on ${rem.target_resource}`);
  cacheLib.updateRemediationStatus(remediation_id, "approved");

  // Step 1: Execute playbook
  console.log(`[approve_remediation] Executing playbook: ${rem.playbook}`);
  const playbookResult = await runWindmillScript("f/devops/response_playbook", {
    playbook: rem.playbook,
    resource: rem.target_resource,
    approval_id: remediation_id,
    dry_run: false,
    params: rem.playbook_params || "{}",
  });

  if (!playbookResult.success || !playbookResult.result?.success) {
    const errMsg = playbookResult.error || playbookResult.result?.error || "Playbook execution failed";
    cacheLib.updateRemediationStatus(remediation_id, "failed", {
      execution_result: JSON.stringify(playbookResult.result || { error: errMsg }),
    });

    // Notify failure
    if (rem.slack_channel) {
      await postSlack(rem.slack_channel,
        `Remediation ${remediation_id} FAILED: ${errMsg}`,
        [{
          type: "section",
          text: { type: "mrkdwn", text: `*Remediation Failed*\n\`${rem.playbook}\` on \`${rem.target_resource}\`\n\nError: ${errMsg}\n\n*Rollback plan:* ${rem.rollback_plan}` },
        }],
      );
    }

    return {
      success: false, remediation_id, action: "executed",
      playbook_result: playbookResult.result,
      rollback_info: rem.rollback_plan,
      error: errMsg,
    };
  }

  console.log(`[approve_remediation] Playbook succeeded. Running verification...`);
  cacheLib.updateRemediationStatus(remediation_id, "executed", {
    execution_result: JSON.stringify(playbookResult.result),
    pre_state: playbookResult.result?.pre_state || null,
  });

  // Step 2: Verify (best-effort — don't fail the whole thing if verification can't run)
  let verificationResult: any = null;
  try {
    // Build minimal investigation structure for verify_remediation
    const verifyResp = await runWindmillScript("f/devops/verify_remediation", {
      item_id: rem.dedup_hash,
      original_investigation: JSON.stringify({
        entities: [{ value: rem.target_resource, type: guessEntityType(rem.target_resource) }],
        evidence: [],
        diagnosis: { summary: rem.diagnosis_summary, severity: rem.severity },
      }),
      playbook_result: JSON.stringify(playbookResult.result),
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

  // Step 3: Post Slack confirmation
  const verified = verificationResult?.verified;
  const verifyEmoji = verified === true ? "white_check_mark" : verified === false ? "warning" : "question";
  const statusText = verified === true ? "Verified" : verified === false ? "Needs Review" : "Verification Skipped";

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
            `*Playbook:* \`${rem.playbook}\` on \`${rem.target_resource}\``,
            `*Result:* ${playbookResult.result?.output || "Executed successfully"}`,
            verified !== undefined ? `*Verification:* :${verifyEmoji}: ${verificationResult?.summary || statusText}` : "",
            `*Rollback:* ${rem.rollback_plan}`,
            rem.sdp_link ? `*SDP:* <${rem.sdp_link}|View Task>` : "",
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
    playbook_result: playbookResult.result,
    verification_result: verificationResult,
    rollback_info: rem.rollback_plan,
  };
}

function guessEntityType(resource: string): string {
  if (resource.startsWith("i-")) return "ec2_instance";
  if (resource.startsWith("sg-")) return "security_group";
  if (resource.startsWith("vol-")) return "volume";
  if (resource.startsWith("AKIA") || resource.startsWith("ASIA")) return "access_key";
  return "unknown";
}
