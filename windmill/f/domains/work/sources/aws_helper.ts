// Windmill Script: AWS Multi-Account Helper
// Shared helper for all AWS investigation tools.
// Provides STS AssumeRole for 16 accounts + local imladris account.
// All queries are READ-ONLY — no write operations.
//
// Usage from other investigate scripts:
//   import { AWS_ACCOUNTS, getAwsCredentials, forEachAccount } from "./aws_helper.ts";

import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

export const AWS_ACCOUNTS: Record<string, { accountId: string; roleArn: string; region: string }> = {
  imladris:         { accountId: "767448074758", roleArn: "",                                                         region: "us-east-1" },
  dev:              { accountId: "899550195859", roleArn: "arn:aws:iam::899550195859:role/ImladrisReadOnly",           region: "us-east-1" },
  qat:              { accountId: "481665097654", roleArn: "arn:aws:iam::481665097654:role/ImladrisReadOnly",           region: "us-east-1" },
  prod:             { accountId: "945243322929", roleArn: "arn:aws:iam::945243322929:role/ImladrisReadOnly",           region: "us-east-1" },
  org:              { accountId: "751182152181", roleArn: "arn:aws:iam::751182152181:role/ImladrisReadOnly",           region: "us-east-1" },
  buxton_qat:       { accountId: "141017301520", roleArn: "arn:aws:iam::141017301520:role/ImladrisReadOnly",           region: "us-east-1" },
  data_collection:  { accountId: "156041442432", roleArn: "arn:aws:iam::156041442432:role/ImladrisReadOnly",           region: "us-east-1" },
  dev01:            { accountId: "211125480617", roleArn: "arn:aws:iam::211125480617:role/ImladrisReadOnly",           region: "us-east-1" },
  testing:          { accountId: "381491869908", roleArn: "arn:aws:iam::381491869908:role/ImladrisReadOnly",           region: "us-east-1" },
  logs:             { accountId: "410382209500", roleArn: "arn:aws:iam::410382209500:role/ImladrisReadOnly",           region: "us-east-1" },
  uat:              { accountId: "495599759895", roleArn: "arn:aws:iam::495599759895:role/ImladrisReadOnly",           region: "us-east-1" },
  dr:               { accountId: "533267062671", roleArn: "arn:aws:iam::533267062671:role/ImladrisReadOnly",           region: "us-east-1" },
  ai_dev:           { accountId: "533267201907", roleArn: "arn:aws:iam::533267201907:role/ImladrisReadOnly",           region: "us-east-1" },
  contractors:      { accountId: "533267356553", roleArn: "arn:aws:iam::533267356553:role/ImladrisReadOnly",           region: "us-east-1" },
  audit:            { accountId: "851725550259", roleArn: "arn:aws:iam::851725550259:role/ImladrisReadOnly",           region: "us-east-1" },
  log_archive:      { accountId: "891377156740", roleArn: "arn:aws:iam::891377156740:role/ImladrisReadOnly",           region: "us-east-1" },
};

const stsClient = new STSClient({ region: "us-east-1" });

export async function getAwsCredentials(accountName: string) {
  const acct = AWS_ACCOUNTS[accountName];
  if (!acct) throw new Error(`Unknown account: ${accountName}`);
  if (!acct.roleArn) return undefined; // local account — use instance profile

  const resp = await stsClient.send(new AssumeRoleCommand({
    RoleArn: acct.roleArn,
    RoleSessionName: `windmill-investigate-${accountName}`,
    DurationSeconds: 900,
  }));

  if (!resp.Credentials) throw new Error(`STS AssumeRole failed for ${accountName}`);

  return {
    accessKeyId: resp.Credentials.AccessKeyId!,
    secretAccessKey: resp.Credentials.SecretAccessKey!,
    sessionToken: resp.Credentials.SessionToken!,
  };
}

export async function forEachAccount<T>(
  accounts: string | string[],
  fn: (credentials: any, accountName: string, region: string) => Promise<T[]>,
): Promise<{ account: string; data: T[] }[]> {
  const targets = accounts === "all"
    ? Object.keys(AWS_ACCOUNTS)
    : Array.isArray(accounts) ? accounts : [accounts];

  const results = await Promise.allSettled(
    targets.map(async (acct) => {
      const creds = await getAwsCredentials(acct);
      const region = AWS_ACCOUNTS[acct]?.region || "us-east-1";
      const items = await fn(creds, acct, region);
      return { account: acct, data: items };
    })
  );

  const output: { account: string; data: T[] }[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      output.push(r.value);
    }
  }
  return output;
}

export function resolveAccounts(account: string): string[] {
  if (account === "all") return Object.keys(AWS_ACCOUNTS);
  return account.split(",").map(a => a.trim()).filter(a => a in AWS_ACCOUNTS);
}

// Windmill main — returns the account map (useful as a debugging/discovery tool)
export async function main() {
  return {
    count: Object.keys(AWS_ACCOUNTS).length,
    accounts: Object.entries(AWS_ACCOUNTS).map(([name, info]) => ({
      name,
      account_id: info.accountId,
      region: info.region,
      uses_role: !!info.roleArn,
    })),
  };
}
