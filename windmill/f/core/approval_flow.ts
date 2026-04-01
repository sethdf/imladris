/**
 * approval_flow.ts - Destructive Operation Approval Request (Decision 28)
 *
 * Building block for Windmill approval flows. Formats an approval request
 * and sends a voice notification. The actual approval step (suspend/resume)
 * is handled by the Windmill Flow definition that calls this script.
 *
 * Usage in a Windmill Flow:
 *   Step 1: Run this script (formats request, sends notification)
 *   Step 2: Windmill "Approve" step (blocks until human approves/rejects)
 *   Step 3: Execute or abort based on approval result
 */

export async function main(
  operation: string,
  resource: string,
  severity: string = "high",
  requested_by: string = "PAI"
): Promise<{
  approval_id: string;
  operation: string;
  resource: string;
  severity: string;
  requested_by: string;
  requested_at: string;
  notification_sent: boolean;
  summary: string;
}> {
  const approval_id = `approve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requested_at = new Date().toISOString();

  const severityLabel = severity === "critical" ? "CRITICAL" :
                        severity === "high" ? "HIGH" :
                        severity === "medium" ? "MEDIUM" : "LOW";

  const summary = `[${severityLabel}] ${operation} on ${resource} — requested by ${requested_by}`;

  // Send voice notification
  let notification_sent = false;
  try {
    const notifyPayload = JSON.stringify({
      message: `Approval required. ${severityLabel} severity. ${operation} on ${resource}.`,
      title: "Approval Required",
    });

    const resp = await fetch("http://localhost:8888/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: notifyPayload,
    });

    notification_sent = resp.ok;
  } catch {
    // Notification server may not be running — non-fatal
    console.log("Voice notification not sent (server unavailable)");
  }

  console.log(`Approval request created: ${approval_id}`);
  console.log(`  Operation: ${operation}`);
  console.log(`  Resource:  ${resource}`);
  console.log(`  Severity:  ${severityLabel}`);
  console.log(`  Requested: ${requested_by} at ${requested_at}`);
  console.log(`  Notified:  ${notification_sent}`);

  return {
    approval_id,
    operation,
    resource,
    severity: severityLabel,
    requested_by,
    requested_at,
    notification_sent,
    summary,
  };
}
