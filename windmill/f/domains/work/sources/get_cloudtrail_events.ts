// Windmill Script: Get CloudTrail Events (Read-Only)
// Investigation tool — queries CloudTrail for EC2 lifecycle events
// (stop, start, terminate, reboot) and IAM/security events.
// Uses LookupEvents API (90-day max, no CloudTrail Lake needed).

import {
  CloudTrailClient,
  LookupEventsCommand,
  type LookupAttribute,
} from "@aws-sdk/client-cloudtrail";
import { getAwsCredentials, AWS_ACCOUNTS, resolveAccounts } from "./aws_helper.ts";

export async function main(
  resource_id: string = "",
  account: string = "all",
  event_names: string = "StopInstances,StartInstances,TerminateInstances,RebootInstances",
  hours_back: number = 168,
  limit: number = 50,
) {
  if (!resource_id) {
    return { error: "resource_id required (e.g., i-0abc123, sg-xxx, vol-xxx)" };
  }

  const targets = resolveAccounts(account);
  const allEvents: any[] = [];
  const cutoff = new Date(Date.now() - hours_back * 3600 * 1000);
  const eventFilter = new Set(event_names.split(",").map(e => e.trim()).filter(Boolean));

  const results = await Promise.allSettled(
    targets.map(async (acct) => {
      const creds = await getAwsCredentials(acct);
      const region = AWS_ACCOUNTS[acct]?.region || "us-east-1";
      const ct = new CloudTrailClient({ region, credentials: creds });

      const lookupAttributes: LookupAttribute[] = [
        { AttributeKey: "ResourceName", AttributeValue: resource_id },
      ];

      const events: any[] = [];
      let nextToken: string | undefined;

      do {
        const resp = await ct.send(new LookupEventsCommand({
          LookupAttributes: lookupAttributes,
          StartTime: cutoff,
          EndTime: new Date(),
          MaxResults: Math.min(limit, 50),
          NextToken: nextToken,
        }));

        for (const evt of resp.Events || []) {
          if (eventFilter.size > 0 && !eventFilter.has(evt.EventName || "")) continue;

          let detail: any = {};
          try {
            detail = JSON.parse(evt.CloudTrailEvent || "{}");
          } catch { /* ignore */ }

          const userIdentity = detail.userIdentity || {};
          const responseItems = detail.responseElements?.instancesSet?.items || [];

          events.push({
            account: acct,
            event_id: evt.EventId,
            event_name: evt.EventName,
            event_time: evt.EventTime?.toISOString(),
            event_source: evt.EventSource,
            username: evt.Username,
            principal_arn: userIdentity.arn,
            principal_type: userIdentity.type,
            source_ip: detail.sourceIPAddress,
            user_agent: detail.userAgent?.split(" ")[0],
            resources: (evt.Resources || []).map(r => ({
              type: r.ResourceType,
              name: r.ResourceName,
            })),
            state_changes: responseItems.map((item: any) => ({
              instance_id: item.instanceId,
              previous_state: item.previousState?.name,
              current_state: item.currentState?.name,
            })),
          });
        }

        nextToken = resp.NextToken;
      } while (nextToken && events.length < limit);

      return events;
    })
  );

  const errors: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      allEvents.push(...r.value);
    } else {
      errors.push(`${targets[i]}: ${r.reason?.message || r.reason}`);
    }
  }

  // Sort by event time descending
  allEvents.sort((a, b) => (b.event_time || "").localeCompare(a.event_time || ""));

  return {
    resource_id,
    hours_back,
    event_filter: [...eventFilter],
    accounts_queried: targets.length,
    count: allEvents.length,
    events: allEvents.slice(0, limit),
    ...(errors.length > 0 ? { errors } : {}),
  };
}
