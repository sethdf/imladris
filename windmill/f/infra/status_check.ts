// Windmill Script: Status Check — Health Dashboard
// Three modes: quick (~2s), full (~15s), datasources (~10s)
// Surfaces box health, data source status, and auto-populated gotchas.
//
// Quick:       Box health + schedules only. Safe to auto-refresh.
// Full:        Everything including 3rd-party data source validation.
// Datasources: Only 3rd-party credential/API checks.

import {
  STSClient,
  AssumeRoleCommand,
  GetCallerIdentityCommand,
} from "@aws-sdk/client-sts";

// --- Helpers ---

const BASE =
  process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
const TOKEN = process.env.WM_TOKEN;
const WS = process.env.WM_WORKSPACE || "imladris";

async function getVariable(path: string): Promise<string | undefined> {
  if (!TOKEN) return undefined;
  try {
    const resp = await fetch(
      `${BASE}/api/w/${WS}/variables/get_value/${path}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    if (!resp.ok) return undefined;
    const val = await resp.text();
    return (val.startsWith('"') ? JSON.parse(val) : val).trim();
  } catch {
    return undefined;
  }
}

async function wmApi(path: string): Promise<any> {
  if (!TOKEN) return null;
  try {
    const resp = await fetch(`${BASE}/api/${path}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return resp.ok ? resp.json() : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

async function runCmd(cmd: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

async function tcpCheck(
  host: string,
  port: number,
  timeoutMs: number = 2000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    try {
      Bun.connect({
        hostname: host,
        port,
        socket: {
          open(socket) {
            clearTimeout(timer);
            socket.end();
            resolve(true);
          },
          error() {
            clearTimeout(timer);
            resolve(false);
          },
          data() {},
          close() {},
        },
      });
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

// --- Box Health Checks ---

async function checkDisk(): Promise<any> {
  try {
    const { stdout: output } = await runCmd(["df", "-P", "/", "/local/cache"]);
    const lines = output.split("\n").slice(1);
    // Deduplicate by mount point
    const seen = new Set<string>();
    return lines
      .map((line) => {
        const p = line.split(/\s+/);
        return {
          filesystem: p[0],
          size_kb: parseInt(p[1]),
          used_kb: parseInt(p[2]),
          available_kb: parseInt(p[3]),
          use_pct: parseInt(p[4]),
          mounted: p[5],
        };
      })
      .filter((d) => {
        if (seen.has(d.mounted)) return false;
        seen.add(d.mounted);
        return true;
      });
  } catch (e: any) {
    return { error: e.message };
  }
}

async function checkCache(): Promise<any> {
  try {
    const { stdout: output } = await runCmd([
      "stat",
      "-c",
      "%Y %s",
      "/local/cache/triage/index.db",
    ]);
    const [mtimeSec, sizeBytes] = output.split(" ").map(Number);
    const ageHours = (Date.now() / 1000 - mtimeSec) / 3600;
    return {
      exists: true,
      size_mb: Math.round((sizeBytes / 1024 / 1024) * 10) / 10,
      age_hours: Math.round(ageHours * 10) / 10,
      last_modified: new Date(mtimeSec * 1000).toISOString(),
    };
  } catch {
    return { exists: false };
  }
}

async function checkWindmill(): Promise<any> {
  try {
    const [versionResp, workers] = await Promise.all([
      fetch(`${BASE}/api/version`).then((r) =>
        r.ok ? r.text() : "unknown",
      ),
      // Try global workers endpoint (admin), fall back to workspace-scoped
      wmApi("workers/list").then((r) =>
        r || wmApi(`w/${WS}/workers/list`),
      ),
    ]);
    return {
      version: versionResp.trim(),
      worker_count: Array.isArray(workers) ? workers.length : 0,
      workers: Array.isArray(workers)
        ? workers.map((w: any) => ({
            worker: w.worker,
            group: w.worker_group,
            last_ping: w.last_ping,
            jobs_executed: w.jobs_executed,
          }))
        : [],
    };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function checkTailscale(): Promise<any> {
  try {
    const { stdout: output, exitCode } = await runCmd(["tailscale", "status", "--json"]);
    if (exitCode !== 0) throw new Error("tailscale not available");
    const data = JSON.parse(output);
    return {
      reachable: true,
      self: data.Self?.HostName,
      tailnet: data.MagicDNSSuffix,
      online: data.Self?.Online,
    };
  } catch {
    // Tailscale CLI not available inside worker — try TCP probe
    const ok = await tcpCheck("100.100.100.100", 80, 2000);
    return { reachable: ok, method: "tcp_probe" };
  }
}

async function checkSteampipe(): Promise<any> {
  const reachable = await tcpCheck("172.17.0.1", 9193, 2000);
  return { reachable, host: "172.17.0.1", port: 9193 };
}

async function checkDocker(): Promise<any> {
  try {
    const { stdout: output, exitCode } = await runCmd([
      "docker",
      "ps",
      "--format",
      "{{.Names}}\t{{.Status}}",
    ]);
    if (exitCode !== 0) {
      return {
        available: false,
        note: "Docker daemon not accessible from worker container",
      };
    }
    const containers = output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, ...statusParts] = line.split("\t");
        return { name, status: statusParts.join("\t") };
      });
    return { count: containers.length, containers };
  } catch {
    return {
      available: false,
      note: "Docker CLI not available in worker container",
    };
  }
}

async function checkSchedules(): Promise<any> {
  try {
    const schedules = await wmApi(
      `w/${WS}/schedules/list?per_page=50`,
    );
    if (!Array.isArray(schedules))
      return { error: "Could not fetch schedules" };

    const results = await Promise.allSettled(
      schedules.map(async (s: any) => {
        const jobs = await wmApi(
          `w/${WS}/jobs/completed/list?schedule_path=${encodeURIComponent(s.path)}&per_page=1`,
        );
        const lastJob = Array.isArray(jobs) ? jobs[0] : null;
        return {
          path: s.path,
          enabled: s.enabled,
          schedule: s.schedule,
          last_run: lastJob
            ? {
                success: lastJob.success,
                started_at: lastJob.started_at,
                duration_ms: lastJob.duration_secs
                  ? Math.round(lastJob.duration_secs * 1000)
                  : null,
              }
            : null,
        };
      }),
    );

    return results
      .filter(
        (r): r is PromiseFulfilledResult<any> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value);
  } catch (e: any) {
    return { error: e.message };
  }
}

// --- Data Source Checks ---

const AWS_CROSS_ACCOUNTS: Record<string, string> = {
  dev: "arn:aws:iam::899550195859:role/ImladrisReadOnly",
  qat: "arn:aws:iam::481665097654:role/ImladrisReadOnly",
  prod: "arn:aws:iam::945243322929:role/ImladrisReadOnly",
  org: "arn:aws:iam::751182152181:role/ImladrisReadOnly",
  buxton_qat: "arn:aws:iam::141017301520:role/ImladrisReadOnly",
  data_collection: "arn:aws:iam::156041442432:role/ImladrisReadOnly",
  dev01: "arn:aws:iam::211125480617:role/ImladrisReadOnly",
  testing: "arn:aws:iam::381491869908:role/ImladrisReadOnly",
  logs: "arn:aws:iam::410382209500:role/ImladrisReadOnly",
  uat: "arn:aws:iam::495599759895:role/ImladrisReadOnly",
  dr: "arn:aws:iam::533267062671:role/ImladrisReadOnly",
  ai_dev: "arn:aws:iam::533267201907:role/ImladrisReadOnly",
  contractors: "arn:aws:iam::533267356553:role/ImladrisReadOnly",
  audit: "arn:aws:iam::851725550259:role/ImladrisReadOnly",
  log_archive: "arn:aws:iam::891377156740:role/ImladrisReadOnly",
};

async function checkAws(): Promise<any> {
  const sts = new STSClient({ region: "us-east-1" });

  let local: any;
  try {
    const resp = await sts.send(new GetCallerIdentityCommand({}));
    local = { account: resp.Account, arn: resp.Arn };
  } catch (e: any) {
    return { error: `Local STS failed: ${e.message}` };
  }

  const entries = Object.entries(AWS_CROSS_ACCOUNTS);
  const results = await Promise.allSettled(
    entries.map(async ([name, roleArn]) => {
      const resp = await sts.send(
        new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: `status-check-${name}`,
          DurationSeconds: 900,
        }),
      );
      return {
        account: name,
        ok: true,
        account_id: resp.AssumedRoleUser?.Arn?.split(":")[4],
      };
    }),
  );

  const accounts = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      account: entries[i][0],
      ok: false,
      error: (r as PromiseRejectedResult).reason?.message,
    };
  });

  const ok = accounts.filter((a) => a.ok).length;
  const failed = accounts.filter((a) => !a.ok);

  return {
    local,
    cross_accounts: { total: entries.length, ok, failed },
  };
}

async function checkAzureAd(): Promise<any> {
  try {
    const [tenantId, clientId, clientSecret] = await Promise.all([
      getVariable("f/devops/m365_tenant_id"),
      getVariable("f/devops/m365_client_id"),
      getVariable("f/devops/m365_client_secret"),
    ]);
    if (!tenantId || !clientId || !clientSecret)
      return { configured: false };

    const resp = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      },
    );

    if (!resp.ok)
      return { configured: true, token_ok: false, status: resp.status };
    const data = (await resp.json()) as { access_token?: string; expires_in?: number };
    return {
      configured: true,
      token_ok: !!data.access_token,
      expires_in: data.expires_in,
    };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function checkSdp(): Promise<any> {
  try {
    const [apiKey, baseUrl] = await Promise.all([
      getVariable("f/devops/sdp_api_key"),
      getVariable("f/devops/sdp_base_url"),
    ]);
    if (!apiKey || !baseUrl) return { configured: false };

    const input = JSON.stringify({ list_info: { row_count: 1 } });
    const resp = await fetch(
      `${baseUrl}/requests?input_data=${encodeURIComponent(input)}`,
      { headers: { Authorization: `Zoho-oauthtoken ${apiKey}`, Accept: "application/vnd.manageengine.sdp.v3+json" } },
    );

    return { configured: true, token_ok: resp.ok, status: resp.status };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function checkSite24x7(): Promise<any> {
  try {
    const token = await getVariable(
      "f/investigate/site24x7_access_token",
    );
    if (!token) return { configured: false };

    const resp = await fetch(
      "https://www.site24x7.com/api/current_status?apm_required=false",
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          Accept: "application/json; version=2.0",
        },
      },
    );

    return { configured: true, token_ok: resp.ok, status: resp.status };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function checkSecuronix(): Promise<any> {
  try {
    const [baseUrl, username, password] = await Promise.all([
      getVariable("f/devops/securonix_base_url"),
      getVariable("f/devops/securonix_username"),
      getVariable("f/devops/securonix_password"),
    ]);
    if (!baseUrl || !username || !password)
      return { configured: false };

    const resp = await fetch(`${baseUrl}/ws/token/generate`, {
      headers: { username, password, validity: "1" },
    });

    return { configured: true, token_ok: resp.ok, status: resp.status };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function checkOkta(): Promise<any> {
  const [orgUrl, apiToken] = await Promise.all([
    getVariable("f/investigate/okta_org_url"),
    getVariable("f/investigate/okta_api_token"),
  ]);

  const isPlaceholder =
    !orgUrl ||
    !apiToken ||
    orgUrl === "PLACEHOLDER" ||
    apiToken === "PLACEHOLDER";
  if (isPlaceholder)
    return { configured: false, status: "unconfigured" };

  // If credentials exist, test them
  try {
    const resp = await fetch(`${orgUrl}/api/v1/org`, {
      headers: { Authorization: `SSWS ${apiToken}` },
    });
    return { configured: true, token_ok: resp.ok, status: resp.status };
  } catch (e: any) {
    return { configured: true, error: e.message };
  }
}

async function checkSophos(): Promise<any> {
  const [clientId, clientSecret] = await Promise.all([
    getVariable("f/devops/sophos_client_id"),
    getVariable("f/devops/sophos_client_secret"),
  ]);

  if (!clientId || !clientSecret)
    return { configured: false, status: "unconfigured" };

  try {
    // OAuth2 token
    const tokenResp = await fetch(
      "https://id.sophos.com/api/v2/oauth2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&scope=token`,
      },
    );
    if (!tokenResp.ok)
      return { configured: true, token_ok: false, status: tokenResp.status };

    const tokenData = await tokenResp.json();

    // Verify tenant access via whoami
    const whoami = await fetch(
      "https://api.central.sophos.com/whoami/v1",
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
    );

    return {
      configured: true,
      token_ok: true,
      tenant_ok: whoami.ok,
      id_type: whoami.ok ? (await whoami.json()).idType : undefined,
      expires_in: tokenData.expires_in,
    };
  } catch (e: any) {
    return { configured: true, error: e.message };
  }
}

// --- Gotchas ---

function computeGotchas(box: any, datasources: any): string[] {
  const gotchas: string[] = [];

  // Disk usage
  if (Array.isArray(box.disk)) {
    for (const d of box.disk) {
      if (d.use_pct > 80)
        gotchas.push(`Disk ${d.mounted} at ${d.use_pct}% usage`);
    }
  }

  // Cache freshness
  if (box.cache?.age_hours > 24) {
    gotchas.push(
      `Triage cache is ${Math.round(box.cache.age_hours)}h stale`,
    );
  }
  if (box.cache?.exists === false) {
    gotchas.push("Triage cache index.db does not exist");
  }

  // Schedule health
  if (Array.isArray(box.schedules)) {
    for (const s of box.schedules) {
      if (s.last_run && !s.last_run.success) {
        gotchas.push(`Schedule ${s.path} last run failed`);
      }
    }
  }

  // Docker containers (skip if not accessible from worker)
  if (box.docker?.available === false) {
    // Not a gotcha — expected from worker container
  } else if (box.docker?.count !== undefined && box.docker.count < 6) {
    gotchas.push(
      `Only ${box.docker.count} Docker containers running (expected >= 6)`,
    );
  }

  // Steampipe
  if (box.steampipe && !box.steampipe.reachable) {
    gotchas.push("Steampipe not reachable at 172.17.0.1:9193");
  }

  // Windmill workers
  if (box.windmill?.worker_count === 0) {
    gotchas.push("No Windmill workers responding");
  }

  // Data sources
  if (datasources.okta?.status === "unconfigured") {
    gotchas.push("Okta credentials not configured (placeholders)");
  }
  if (datasources.azure_ad?.configured && !datasources.azure_ad?.token_ok) {
    gotchas.push("Azure AD token acquisition failed");
  }
  if (datasources.sdp?.configured && !datasources.sdp?.token_ok) {
    gotchas.push("SDP API token invalid or expired");
  }
  if (datasources.site24x7?.configured && !datasources.site24x7?.token_ok) {
    gotchas.push("Site24x7 token invalid or expired");
  }
  if (
    datasources.securonix?.configured &&
    !datasources.securonix?.token_ok
  ) {
    gotchas.push("Securonix token generation failed");
  }
  if (datasources.aws?.cross_accounts?.failed?.length > 0) {
    const n = datasources.aws.cross_accounts.failed.length;
    gotchas.push(`${n} AWS cross-account role(s) failed STS AssumeRole`);
  }
  if (datasources.sophos?.configured && !datasources.sophos?.token_ok) {
    gotchas.push("Sophos Central token acquisition failed");
  }

  return gotchas;
}

// --- Main ---

export async function main(
  mode: "quick" | "full" | "datasources" = "quick",
) {
  const started = Date.now();
  const FAST_TIMEOUT = 2000;
  const SLOW_TIMEOUT = 10000;

  let box: any = {};
  let datasources: any = {};

  if (mode === "quick" || mode === "full") {
    const [disk, cache, windmill, tailscale, steampipe, docker, schedules] =
      await Promise.allSettled([
        withTimeout(checkDisk(), FAST_TIMEOUT, "disk"),
        withTimeout(checkCache(), FAST_TIMEOUT, "cache"),
        withTimeout(checkWindmill(), FAST_TIMEOUT, "windmill"),
        withTimeout(checkTailscale(), FAST_TIMEOUT, "tailscale"),
        withTimeout(checkSteampipe(), FAST_TIMEOUT, "steampipe"),
        withTimeout(checkDocker(), FAST_TIMEOUT, "docker"),
        withTimeout(checkSchedules(), FAST_TIMEOUT * 2, "schedules"),
      ]);

    const extract = (r: PromiseSettledResult<any>) =>
      r.status === "fulfilled"
        ? r.value
        : { error: (r as PromiseRejectedResult).reason?.message };

    box = {
      disk: extract(disk),
      cache: extract(cache),
      windmill: extract(windmill),
      tailscale: extract(tailscale),
      steampipe: extract(steampipe),
      docker: extract(docker),
      schedules: extract(schedules),
    };
  }

  if (mode === "full" || mode === "datasources") {
    const [aws, azureAd, sdp, site24x7, securonix, okta, sophos] =
      await Promise.allSettled([
        withTimeout(checkAws(), SLOW_TIMEOUT, "aws"),
        withTimeout(checkAzureAd(), SLOW_TIMEOUT, "azure_ad"),
        withTimeout(checkSdp(), SLOW_TIMEOUT, "sdp"),
        withTimeout(checkSite24x7(), SLOW_TIMEOUT, "site24x7"),
        withTimeout(checkSecuronix(), SLOW_TIMEOUT, "securonix"),
        withTimeout(checkOkta(), FAST_TIMEOUT, "okta"),
        withTimeout(checkSophos(), SLOW_TIMEOUT, "sophos"),
      ]);

    const extract = (r: PromiseSettledResult<any>) =>
      r.status === "fulfilled"
        ? r.value
        : { error: (r as PromiseRejectedResult).reason?.message };

    datasources = {
      aws: extract(aws),
      azure_ad: extract(azureAd),
      sdp: extract(sdp),
      site24x7: extract(site24x7),
      securonix: extract(securonix),
      okta: extract(okta),
      sophos: extract(sophos),
    };
  }

  const gotchas = computeGotchas(box, datasources);

  return {
    mode,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    gotchas,
    ...(Object.keys(box).length > 0 ? { box } : {}),
    ...(Object.keys(datasources).length > 0 ? { datasources } : {}),
  };
}
