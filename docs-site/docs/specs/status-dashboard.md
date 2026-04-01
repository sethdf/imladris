---
sidebar_position: 5
---

# Status Page: Tailscale-Only Health Dashboard

## Context

Seth wants a basic status page accessible only via Tailscale that shows: box health, 3rd-party data source status, and operational gotchas. All ports are already bound to 127.0.0.1 — Tailscale mesh is the only network access. The page should surface problems proactively so nothing silently breaks.

## Architecture: Two Components

### 1. `f/devops/status_check.ts` — Windmill Health Check Script

A single Windmill script that collects all health data and returns structured JSON. Three modes:

- **`quick`** (default, ~2s) — Box health + schedules only. Safe to auto-refresh.
- **`full`** (~15s) — Everything including 3rd-party data source validation.
- **`datasources`** (~10s) — Only 3rd-party checks.

**Box health checks (quick mode):**
- Docker containers (5 expected: server, 3 workers, db, lsp) via `Bun.spawn(["docker", "ps"])`
- Disk usage (root `/` and NVMe `/local`) via `Bun.spawn(["df"])`
- Cache freshness (`/local/cache/triage/index.db` age and size)
- Windmill version + workers via internal API
- Tailscale status via `Bun.spawn(["tailscale", "status", "--json"])`
- Steampipe reachability (TCP connect to 172.17.0.1:9193)
- Schedule health — last run status for all 11 schedules via Windmill jobs API

**Data source checks (full/datasources mode):**
- AWS: STS GetCallerIdentity on all 16 cross-account roles (parallel)
- Azure AD: OAuth2 token acquisition test
- SDP: Token freshness check + lightweight API call
- Site24x7: Token freshness + API call
- Securonix: Token generation test
- Okta: Report as "unconfigured" (placeholders)

**Gotchas array** — auto-populated warnings:
- Disk >80%, cache >24h stale, failed schedule runs, unhealthy containers, unreachable Steampipe, unconfigured Okta, expired/failing tokens

All checks use `Promise.allSettled` with per-check timeouts (2s fast, 10s slow).

### 2. `tailscale serve --bg 8000` — Expose Windmill to Tailnet

One-time setup command. Makes Windmill (and the status check API) available at `https://imladris-4.<tailnet>.ts.net`. HTTPS via Tailscale certs, no public exposure.

The status check is then callable at:
```
https://imladris-4.<tailnet>.ts.net/api/w/imladris/jobs/run_wait_result/p/f/devops/status_check
```

Windmill UI renders the JSON result in a readable tree view — no custom HTML needed for "basic."

## Files to Create

| File | Purpose |
|------|---------|
| `f/devops/status_check.ts` | Core health check script (~200 lines) |
| `f/devops/status_check.script.yaml` | Auto-generated metadata |
| `f/devops/status_check.script.lock` | Auto-generated lock |

## Patterns to Reuse

- `f/devops/refresh_sdp_token.ts` — `getVariable()` helper using `BASE_INTERNAL_URL` + `WM_TOKEN`
- `f/investigate/aws_helper.ts` — `AWS_ACCOUNTS` map + `getAwsCredentials()` for multi-account STS
- `f/investigate/get_azure_users.ts` — Azure AD OAuth2 client_credentials flow (lines 14-36)
- `f/investigate/get_security_events.ts` — Securonix token generation pattern
- `f/investigate/get_monitoring_alerts.ts` — Site24x7 access token usage

## Verification

1. Deploy script: `wmill script generate-metadata` + `wmill sync push`
2. Run quick mode: `wmill script run f/devops/status_check -d '{"mode":"quick"}'` — returns in <3s with box health
3. Run full mode: `wmill script run f/devops/status_check -d '{"mode":"full"}'` — returns in <20s with all data sources
4. Verify gotchas array catches known issues (Okta unconfigured should always appear)
5. Set up `tailscale serve`: `sudo tailscale serve --bg 8000`
6. Access from another Tailscale device to confirm HTTPS works
