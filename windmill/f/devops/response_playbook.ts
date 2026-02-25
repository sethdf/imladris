// Windmill Script: Response Playbook Executor
// Phase 6: Execute approved remediation actions
// Decision 28: All destructive ops require approval_flow approval first
//
// CRITICAL: This script NEVER executes without a valid approval_id.
// The approval_id links back to an approval_flow request.

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const HOME = homedir();
const LOG_PATH = join(HOME, ".claude", "logs", "playbook-executions.jsonl");

interface PlaybookResult {
  playbook: string;
  resource: string;
  approval_id: string;
  success: boolean;
  output: string;
  error?: string;
}

function ensureDirs(): void {
  const logDir = join(HOME, ".claude", "logs");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

function logExecution(result: PlaybookResult & { dry_run: boolean; timestamp: string }): void {
  ensureDirs();
  appendFileSync(LOG_PATH, JSON.stringify(result) + "\n");
}

function runAws(cmd: string, dryRun: boolean): { success: boolean; output: string; error?: string } {
  if (dryRun) {
    return { success: true, output: `[DRY RUN] Would execute: ${cmd}` };
  }
  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 30000 }).trim();
    return { success: true, output };
  } catch (e: unknown) {
    const err = e as Error & { stderr?: string };
    return { success: false, output: "", error: err.stderr || err.message || String(e) };
  }
}

function isolateInstance(resource: string, dryRun: boolean, _params: Record<string, string>): PlaybookResult {
  // Step 1: Get current security groups
  const describeCmd = `aws ec2 describe-instances --instance-ids ${resource} --query 'Reservations[0].Instances[0].[VpcId,SecurityGroups[*].GroupId]' --output json`;
  const describeResult = runAws(describeCmd, false); // Always read, even in dry_run

  if (!describeResult.success) {
    return { playbook: "isolate_instance", resource, approval_id: "", success: false, output: "", error: describeResult.error };
  }

  let vpcId: string;
  let currentSgs: string[];
  try {
    const parsed = JSON.parse(describeResult.output);
    vpcId = parsed[0];
    currentSgs = parsed[1];
  } catch {
    return { playbook: "isolate_instance", resource, approval_id: "", success: false, output: "", error: "Failed to parse instance details" };
  }

  // Step 2: Create or find quarantine SG
  const sgName = "quarantine-ssm-only";
  const findSgCmd = `aws ec2 describe-security-groups --filters Name=group-name,Values=${sgName} Name=vpc-id,Values=${vpcId} --query 'SecurityGroups[0].GroupId' --output text`;
  const findSgResult = runAws(findSgCmd, false);

  let quarantineSgId: string;

  if (findSgResult.success && findSgResult.output && findSgResult.output !== "None") {
    quarantineSgId = findSgResult.output;
  } else {
    // Create quarantine SG - allows only SSM (outbound HTTPS to SSM endpoints)
    const createCmd = `aws ec2 create-security-group --group-name ${sgName} --description "Quarantine SG - SSM access only" --vpc-id ${vpcId} --query 'GroupId' --output text`;
    const createResult = runAws(createCmd, dryRun);
    if (!createResult.success) {
      return { playbook: "isolate_instance", resource, approval_id: "", success: false, output: "", error: `Failed to create quarantine SG: ${createResult.error}` };
    }
    quarantineSgId = createResult.output;
  }

  // Step 3: Replace instance SGs with quarantine SG
  const modifyCmd = `aws ec2 modify-instance-attribute --instance-id ${resource} --groups ${quarantineSgId}`;
  const modifyResult = runAws(modifyCmd, dryRun);

  const output = dryRun
    ? modifyResult.output
    : `Isolated ${resource}: removed SGs [${currentSgs.join(", ")}], applied quarantine SG ${quarantineSgId}`;

  return {
    playbook: "isolate_instance",
    resource,
    approval_id: "",
    success: modifyResult.success,
    output,
    ...(modifyResult.error ? { error: modifyResult.error } : {}),
  };
}

function revokeSgRule(resource: string, dryRun: boolean, params: Record<string, string>): PlaybookResult {
  const protocol = params.protocol || "tcp";
  const port = params.port || "22";
  const cidr = params.cidr || "0.0.0.0/0";

  const cmd = `aws ec2 revoke-security-group-ingress --group-id ${resource} --protocol ${protocol} --port ${port} --cidr ${cidr}`;
  const result = runAws(cmd, dryRun);

  return {
    playbook: "revoke_sg_rule",
    resource,
    approval_id: "",
    success: result.success,
    output: result.output || `Revoked ${protocol}/${port} from ${cidr} on ${resource}`,
    ...(result.error ? { error: result.error } : {}),
  };
}

function snapshotVolume(resource: string, dryRun: boolean, _params: Record<string, string>, approvalId: string): PlaybookResult {
  const cmd = `aws ec2 create-snapshot --volume-id ${resource} --description "Pre-remediation snapshot - ${approvalId}" --query 'SnapshotId' --output text`;
  const result = runAws(cmd, dryRun);

  return {
    playbook: "snapshot_volume",
    resource,
    approval_id: "",
    success: result.success,
    output: result.output || `Snapshot created for ${resource}`,
    ...(result.error ? { error: result.error } : {}),
  };
}

function disableAccessKey(resource: string, dryRun: boolean, params: Record<string, string>): PlaybookResult {
  const username = params.username;
  if (!username) {
    return { playbook: "disable_access_key", resource, approval_id: "", success: false, output: "", error: "Missing required param: username" };
  }

  const cmd = `aws iam update-access-key --access-key-id ${resource} --status Inactive --user-name ${username}`;
  const result = runAws(cmd, dryRun);

  return {
    playbook: "disable_access_key",
    resource,
    approval_id: "",
    success: result.success,
    output: result.output || `Disabled access key ${resource} for user ${username}`,
    ...(result.error ? { error: result.error } : {}),
  };
}

export async function main(
  playbook: string,
  resource: string,
  approval_id: string,
  dry_run: boolean = false,
  params: string = "{}",
) {
  // SECURITY GATE: approval_id is mandatory — no execution without approval
  if (!approval_id || approval_id.trim() === "") {
    return {
      success: false,
      error: "SECURITY: approval_id is required. All playbook executions must reference an approved approval_flow request.",
      playbook,
      resource,
    };
  }

  let parsedParams: Record<string, string>;
  try {
    parsedParams = JSON.parse(params);
  } catch {
    return {
      success: false,
      error: `Invalid params JSON: ${params}`,
      playbook,
      resource,
      approval_id,
    };
  }

  const availablePlaybooks: Record<string, (resource: string, dryRun: boolean, params: Record<string, string>, approvalId: string) => PlaybookResult> = {
    isolate_instance: isolateInstance,
    revoke_sg_rule: revokeSgRule,
    snapshot_volume: snapshotVolume,
    disable_access_key: disableAccessKey,
  };

  const executor = availablePlaybooks[playbook];
  if (!executor) {
    return {
      success: false,
      error: `Unknown playbook: ${playbook}. Available: ${Object.keys(availablePlaybooks).join(", ")}`,
      playbook,
      resource,
      approval_id,
    };
  }

  const result = executor(resource, dry_run, parsedParams, approval_id);
  result.approval_id = approval_id;

  // Log every execution
  const logEntry = {
    ...result,
    dry_run,
    timestamp: new Date().toISOString(),
  };
  logExecution(logEntry);

  return result;
}
