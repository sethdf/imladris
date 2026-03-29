---
sidebar_position: 1
---

# DevOps Automation

~55 Windmill scripts in `windmill/f/devops/` form the automation backbone. They run on schedule, via webhook, or are called by other scripts in the pipeline.

[📁 View all sources → `windmill/f/devops/`](https://github.com/sethdf/imladris/tree/main/windmill/f/devops)

## Pipeline (Triage → Investigate → Act)

These scripts form the core automation pipeline, executing in sequence for each actionable item.

| Script | What it does | Source |
|--------|-------------|--------|
| **triage_pipeline.ts** | Central coordinator — classifies incoming items via Bedrock Sonnet, routes to investigation, proposes fix | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/triage_pipeline.ts) |
| **agentic_investigator.ts** | Bedrock Converse tool-use loop — autonomously investigates alerts using 20 investigation tools across up to 8 rounds | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/agentic_investigator.ts) |
| **process_actionable.ts** | Three-phase pipeline — investigate, create SDP tasks, escalate high-priority items to Slack | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/process_actionable.ts) |
| **approval_flow.ts** | Human approval workflow for remediation actions that require review before execution | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/approval_flow.ts) |
| **approve_remediation.ts** | Executes approved remediation actions after human sign-off | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/approve_remediation.ts) |
| **verify_remediation.ts** | Post-remediation verification — confirms the fix resolved the original condition | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/verify_remediation.ts) |
| **response_playbook.ts** | Structured incident response playbook execution for known event types | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/response_playbook.ts) |

## Ingestion (Batch Triage)

Scripts that batch-process incoming signal sources on schedule.

| Script | What it does | Source |
|--------|-------------|--------|
| **batch_triage_emails.ts** | Deduplicates emails, classifies via Haiku, stores results with instant L1 output | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/batch_triage_emails.ts) |
| **batch_triage_slack.ts** | Pulls unread Slack messages, classifies, routes actionable items to pipeline | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/batch_triage_slack.ts) |
| **batch_triage_sdp.ts** | Polls SDP for new/updated tickets, classifies, correlates with active alerts | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/batch_triage_sdp.ts) |
| **batch_triage_telegram.ts** | Reads Telegram messages, classifies, routes to pipeline | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/batch_triage_telegram.ts) |
| **auto_triage.ts** | Unified auto-triage dispatcher across all sources | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/auto_triage.ts) |
| **feed_collector.ts** | Collects threat intel and vendor feed updates | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/feed_collector.ts) |
| **reingest_dismissed.ts** | Re-queues previously dismissed items after a configurable cool-down period | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/reingest_dismissed.ts) |

## SDP (Service Desk)

Scripts for managing SDP tickets and tasks.

| Script | What it does | Source |
|--------|-------------|--------|
| **create_ticket.ts** | Creates SDP tickets from investigation findings with structured details | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/create_ticket.ts) |
| **create_task.ts** | Creates SDP tasks (sub-items of tickets) | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/create_task.ts) |
| **close_ticket.ts** | Closes SDP tickets with resolution notes | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/close_ticket.ts) |
| **list_tickets.ts** | Lists SDP tickets with filtering | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/list_tickets.ts) |
| **sdp_morning_summary.ts** | Daily morning briefing from SDP — open tickets, priorities, catchup tracking | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/sdp_morning_summary.ts) |
| **sdp_aws_correlate.ts** | Correlates SDP tickets with AWS events for root cause analysis | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/sdp_aws_correlate.ts) |
| **investigate_sdp_tickets.ts** | Runs agentic investigation against open SDP tickets | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/investigate_sdp_tickets.ts) |
| **refresh_sdp_token.ts** | Refreshes SDP OAuth token, stores to Windmill variable store | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/refresh_sdp_token.ts) |

## Reporting & Monitoring (Scheduled)

Scripts that run on cron to produce reports and health checks.

| Script | What it does | Schedule |  Source |
|--------|-------------|----------|--------|
| **compliance_scan.ts** | Steampipe SQL queries → compliance findings by category and status | Daily | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/compliance_scan.ts) |
| **cost_report.ts** | AWS cost breakdown via Steampipe (Architecture Decision #26) | Daily | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/cost_report.ts) |
| **activity_report.ts** | Manager-friendly activity summary from mcp-calls.jsonl + current-work.json | Daily/Weekly | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/activity_report.ts) |
| **audit_investigation_coverage.ts** | Audits Windmill credentials vs deployed f/investigate/ scripts — reports gaps to Slack | Daily | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/audit_investigation_coverage.ts) |
| **investigation_accuracy_digest.ts** | Digest of investigation accuracy metrics and false positive rates | Daily | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/investigation_accuracy_digest.ts) |
| **monitor_worker_health.ts** | Checks Windmill worker health, alerts if stuck >5 minutes | Scheduled | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/monitor_worker_health.ts) |
| **parse_windmill_logs.ts** | Parses Windmill job logs for errors, patterns, and anomalies | Scheduled | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/parse_windmill_logs.ts) |
| **upstream_updates.ts** | Checks for upstream tool/dependency updates | Weekly | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/upstream_updates.ts) |

## Utilities & Libraries

Shared libraries and utility scripts used by the pipeline.

| Script | What it does | Source |
|--------|-------------|--------|
| **bedrock.ts** | AWS Bedrock wrapper — Haiku/Sonnet/Opus calls with retry + cost tracking | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/bedrock.ts) |
| **cache_lib.ts** | Windmill KV cache library for deduplication and result caching | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/cache_lib.ts) |
| **catchup_lib.ts** | Tracks "catchup" state for scheduled summaries — prevents duplicate sends | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/catchup_lib.ts) |
| **knowledge_store.ts** | Reads/writes the Windmill KV knowledge base for investigation context | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/knowledge_store.ts) |
| **entity_extract.ts** | Extracts entities (IPs, users, domains, ARNs) from alert text | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/entity_extract.ts) |
| **correlate_triage.ts** | Cross-correlates triage items to find related events | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/correlate_triage.ts) |
| **cross_correlate.ts** | Multi-source correlation engine for building event timelines | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/cross_correlate.ts) |
| **slack_post_message.ts** | Posts messages to Slack — always routes to Seth's DM (`U06H2KKCCET`) by default | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/slack_post_message.ts) |
| **manage_credentials.ts** | Manages Windmill variable store credentials lifecycle | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/manage_credentials.ts) |
| **mcp_server.ts** | Windmill MCP server — exposes scripts as MCP tools for Claude Code | [📄](https://github.com/sethdf/imladris/blob/main/windmill/f/devops/mcp_server.ts) |
