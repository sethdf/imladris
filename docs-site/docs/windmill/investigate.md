---
id: windmill/investigate
sidebar_position: 2
---

# Investigation Tools

~45 read-only scripts in `windmill/f/investigate/` are the investigation layer. They are called by `agentic_investigator.ts` during autonomous investigation, and are usable directly from Windmill or via MCP tools in Claude Code.

All scripts are **read-only** — they never modify resources.

[📁 View all sources → `windmill/f/investigate/`](https://github.com/sethdf/imladris/tree/main/windmill/f/investigate)

## AWS

| Script | What it does | Source |
|--------|-------------|--------|
| **get_aws_resources.ts** | Lists RDS, Lambda, S3, or ECS resources across accounts with type filtering | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_aws_resources.ts) |
| **get_ec2_instances.ts** | Lists EC2 instances with state, type, and tag details | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_ec2_instances.ts) |
| **get_cloudtrail_events.ts** | Queries CloudTrail for EC2 lifecycle + IAM/security events (90-day max) | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_cloudtrail_events.ts) |
| **get_cloudwatch_alarms.ts** | Lists CloudWatch alarms with state (OK, ALARM, INSUFFICIENT_DATA) | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_cloudwatch_alarms.ts) |
| **get_cloudwatch_metrics.ts** | Retrieves CloudWatch metric data for a given namespace, metric, and time range | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_cloudwatch_metrics.ts) |
| **get_security_groups.ts** | Lists EC2 security groups with inbound/outbound rules | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_security_groups.ts) |
| **get_security_events.ts** | Retrieves AWS Security Hub findings and GuardDuty events | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_security_events.ts) |
| **query_steampipe.ts** | Runs SQL queries against Steampipe for cross-account AWS resource lookups | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/query_steampipe.ts) |
| **query_resources.ts** | Unified resource query across multiple AWS services | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/query_resources.ts) |
| **aws_helper.ts** | Shared AWS SDK helper — cross-account role assumption, client factory | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/aws_helper.ts) |

## Azure / Microsoft 365

| Script | What it does | Source |
|--------|-------------|--------|
| **get_azure_sign_ins.ts** | Queries Azure AD sign-in logs via Microsoft Graph API (requires `user_email`) | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_azure_sign_ins.ts) |
| **get_azure_users.ts** | Lists Azure AD users with MFA status, roles, and last sign-in | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_azure_users.ts) |
| **get_azure_devices.ts** | Lists Intune-managed devices with compliance status | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_azure_devices.ts) |
| **get_identity_info.ts** | Unified identity lookup across Azure AD and AWS IAM | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_identity_info.ts) |

## Cloudflare

| Script | What it does | Source |
|--------|-------------|--------|
| **cloudflare_get_firewall_events.ts** | Queries WAF/firewall events for a zone with action filtering | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/cloudflare_get_firewall_events.ts) |
| **cloudflare_get_dns.ts** | Retrieves DNS records for a Cloudflare zone | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/cloudflare_get_dns.ts) |
| **cloudflare_list_zones.ts** | Lists all Cloudflare zones in the account | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/cloudflare_list_zones.ts) |
| **cloudflare_helper.ts** | Shared Cloudflare API helper — auth, pagination, error handling | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/cloudflare_helper.ts) |

## SIEM — SigNoz

| Script | What it does | Source |
|--------|-------------|--------|
| **signoz_query_logs.ts** | Searches logs via SigNoz v3 query_range API with severity and service filtering | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/signoz_query_logs.ts) |
| **signoz_query_metrics.ts** | Retrieves metrics from SigNoz for dashboards and anomaly detection | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/signoz_query_metrics.ts) |
| **signoz_get_alerts.ts** | Gets active SigNoz alerts with severity and rule details | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/signoz_get_alerts.ts) |
| **signoz_helper.ts** | Shared SigNoz API helper — auth, query builder | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/signoz_helper.ts) |

## Endpoint Security — Sophos

| Script | What it does | Source |
|--------|-------------|--------|
| **sophos_get_alerts.ts** | Retrieves Sophos Central security alerts with category and severity filtering | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/sophos_get_alerts.ts) |
| **sophos_get_events.ts** | Gets Sophos endpoint security events with event type filtering | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/sophos_get_events.ts) |
| **sophos_list_endpoints.ts** | Lists Sophos-managed endpoints with health status and last seen | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/sophos_list_endpoints.ts) |
| **sophos_helper.ts** | Shared Sophos Central API helper — OAuth token, tenant routing | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/sophos_helper.ts) |

## Vulnerability Management — Aikido

| Script | What it does | Source |
|--------|-------------|--------|
| **aikido_list_issues.ts** | Lists open vulnerability groups from Aikido with severity and type filtering | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/aikido_list_issues.ts) |
| **aikido_list_threats.ts** | Lists active threat detections from Aikido runtime | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/aikido_list_threats.ts) |
| **aikido_get_issue.ts** | Gets detailed information on a specific Aikido vulnerability | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/aikido_get_issue.ts) |
| **aikido_list_repos.ts** | Lists repositories tracked in Aikido with scan status | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/aikido_list_repos.ts) |
| **aikido_get_repo.ts** | Gets detailed Aikido findings for a specific repository | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/aikido_get_repo.ts) |
| **aikido_list_clouds.ts** | Lists cloud environments monitored by Aikido | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/aikido_list_clouds.ts) |
| **aikido_list_containers.ts** | Lists container images and vulnerability counts from Aikido | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/aikido_list_containers.ts) |
| **aikido_compliance_overview.ts** | Gets Aikido compliance posture summary across frameworks | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/aikido_compliance_overview.ts) |
| **aikido_helper.ts** | Shared Aikido API helper — auth, pagination | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/aikido_helper.ts) |

## Slack

| Script | What it does | Source |
|--------|-------------|--------|
| **slack_search.ts** | Searches messages across Slack workspace (requires user token) | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/slack_search.ts) |
| **slack_read_channel.ts** | Reads recent messages from a Slack channel | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/slack_read_channel.ts) |
| **slack_read_thread.ts** | Reads a specific Slack thread by channel + timestamp | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/slack_read_thread.ts) |
| **slack_list_channels.ts** | Lists all Slack channels the bot has access to | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/slack_list_channels.ts) |
| **slack_user_info.ts** | Gets Slack user profile by ID or email | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/slack_user_info.ts) |
| **slack_helper.ts** | Shared Slack Web API helper — bot token, user token, rate limiting | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/slack_helper.ts) |

## Telegram

| Script | What it does | Source |
|--------|-------------|--------|
| **telegram_read_messages.ts** | Returns messages from a Telegram chat by ID, username, or title search | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/telegram_read_messages.ts) |
| **telegram_list_chats.ts** | Lists accessible Telegram chats with message counts | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/telegram_list_chats.ts) |
| **telegram_helper.ts** | Shared Telegram MTProto client helper | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/telegram_helper.ts) |

## Monitoring & Network

| Script | What it does | Source |
|--------|-------------|--------|
| **get_monitoring_alerts.ts** | Retrieves active monitoring alerts from Site24x7 | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_monitoring_alerts.ts) |
| **check_network.ts** | Network connectivity checks — DNS, port reachability, latency | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/check_network.ts) |
| **get_sdp_tickets.ts** | Reads SDP tickets for investigation context | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/get_sdp_tickets.ts) |
| **search_alert_history.ts** | Searches historical alert records for pattern matching | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/search_alert_history.ts) |
| **load_domain_knowledge.ts** | Loads relevant knowledge base entries for investigation context | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/load_domain_knowledge.ts) |
| **context7_query_docs.ts** | Queries Context7 for up-to-date library/API documentation | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/context7_query_docs.ts) |
| **context7_resolve_library.ts** | Resolves library names to Context7 IDs for doc lookup | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/context7_resolve_library.ts) |
| **triage_overview.ts** | Provides a summary view of current triage queue state | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/triage_overview.ts) |
| **query_vendors.ts** | Queries vendor-specific APIs for product/license/subscription info | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/investigate/query_vendors.ts) |
