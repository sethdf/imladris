# DevOps Architecture Decisions & Discoveries

## Date: 2026-02-18

---

## 1. API Integration Strategy (PAI)

PAI has 3 established patterns for third-party API access:
- **`.env` + CLI Tools** (`~/.claude/skills/PAI/Tools/`) — the primary PAI way
- **MCP Servers** — native Claude tool access, configured in `settings.json`
- **Cloudflare Workers (Arbol)** — for production/webhook APIs

Decision tree: Quick API call → CLI Tool. Native AI tool access → MCP. Running service → Worker.

---

## 2. Steampipe — Read-Only SQL Over APIs

- **153+ plugins** — AWS (500+ tables), Azure, GCP, GitHub, Kubernetes, SaaS, threat intel, etc.
- **100% read-only** — SELECT only, zero risk of modifying anything
- **Killer feature:** SQL JOINs across services for cross-service correlation
- **AWS billing tables:** `aws_cost_by_service_daily/monthly`, `aws_cost_by_account`, `aws_cost_by_tag`, `aws_cost_forecast`, `aws_cost_usage`
- **Powerpipe companion:** Pre-built compliance benchmarks (CIS, PCI, NIST, HIPAA, SOC 2, GDPR, FedRAMP)
- **Cost Explorer note:** Cost tables hit AWS Cost Explorer API at $0.01/request, Steampipe caches

**Not installed yet.** Install with: `brew install turbot/tap/steampipe && steampipe plugin install aws`
On Fedora: check https://steampipe.io/downloads for Linux install method.

---

## 3. CLI-First vs MCP — No Real Tension

Anthropic's own position: **"Tools represent contracts between deterministic systems and non-deterministic agents."**

Key Anthropic insight: **"Human and agent ergonomics align."** Tools designed for AI become intuitive for humans too.

**MCP is not against CLI-First.** MCP is a standardized protocol for connecting non-deterministic agents to deterministic tools. The patterns are compatible:

```
CLI-First:     Deterministic tools → AI orchestrates via Bash
Anthropic MCP: Deterministic tools → AI orchestrates via protocol
```

Both require deterministic tools underneath. The transport differs, the principle is the same.

**The refined architecture:**
```
CLI Tool (deterministic core, testable, scriptable)
  ↑
MCP Server (thin wrapper, manages auth, exposes as protocol)
  ↑
AI / Claude Code (calls tools, never sees credentials)
```

The CLI tool exists independently. MCP is one interface to it. CLI is another. Both call the same code.

---

## 4. MCP Auth — Standardized on OAuth 2.1

- March 2025: MCP adopted OAuth 2.1
- June 2025: Added Resource Indicators (RFC 8707) to prevent token abuse
- November 2025: Added enterprise-managed auth via Cross App Access (XAA)

MCP server handles auth internally — AI never sees/touches credentials. This is a genuine advantage over raw `.env` files, especially for OAuth flows (token refresh, expiry, re-auth).

---

## 5. MCP Can Be Called From CLI

**mcp-tools** (`github.com/f/mcptools`) — Go CLI for calling MCP servers directly:

```bash
mcp tools npx -y @awslabs/mcp              # List available tools
mcp call list_ec2 --params '{"region":"us-east-1"}' npx -y @awslabs/mcp  # Call a tool
mcp shell npx -y @awslabs/mcp              # Interactive REPL
```

Supports: stdio transport, HTTP/HTTPS, auth headers, JSON output piping.
This makes MCP CLI-First compliant — deterministic calls with explicit params.

---

## 6. AWS MCP Servers

**Managed AWS MCP (Preview):** Unified access to AWS APIs, IAM auth, CloudTrail audit logging built in.
**66 service-specific servers (awslabs):** CDK, CloudFormation, EKS, ECS, DynamoDB, S3, Bedrock, etc.

Start with managed AWS MCP for broad access. Add specialized servers as needed.

---

## 7. ServiceDesk Plus Cloud Integration

**API:** REST API v3 — https://www.manageengine.com/products/service-desk/sdpod-v3-api/SDPOD-V3-API.html
**Auth:** OAuth 2.0 via Zoho (register Self Client in Zoho API Console)

**Existing MCP server:** `github.com/SChinmaya15/Manage-Engine-MCP`
- 20+ tools (tickets, KB, software, computers, automation)
- OAuth2 with auto-refresh
- Early stage (2 commits, no releases) — community project, not official

**Zapier MCP option:** Generic hosted gateway, 2 Zapier tasks per call, limited to pre-built actions. Not recommended for serious use.

**Recommended path:** Build CLI tool first (Tools/ServiceDeskPlus.ts), optionally wrap as MCP later.

---

## 8. PAI MCP Logging Hook — TO BUILD

PAI hook system can intercept ALL MCP calls via `mcp__*` wildcard matcher.
Settings already auto-allow `mcp__*` tools.

**Add to settings.json hooks:**
```json
{
  "PreToolUse": [
    {
      "matcher": "mcp__*",
      "hooks": [
        { "type": "command", "command": "~/.claude/hooks/McpLogger.hook.ts" }
      ]
    }
  ]
}
```

**Hook receives on stdin:**
```typescript
{
  tool_name: "mcp__aws__list_ec2_instances",
  tool_input: { region: "us-east-1" },
  tool_output: { ... },  // PostToolUse only
  session_id: "abc-123"
}
```

Logs to `~/.claude/logs/mcp-calls.jsonl` — timestamp, session, tool, params.
Add PostToolUse matcher for response logging too.

**Status: NOT YET BUILT** — needs McpLogger.hook.ts created and settings.json updated.

---

## 9. Recommended Implementation Sequence

1. **Now:** Install Steampipe + AWS plugin for instant research/correlation
2. **Soon:** Build MCP logging hook (McpLogger.hook.ts)
3. **Soon:** Build Tools/ServiceDeskPlus.ts CLI wrapper
4. **Later:** Set up AWS MCP server for native Claude access
5. **Later:** Add Windmill for scheduled/unattended automation

---

## 10. Key Principles Established

- **CLI-First is compatible with MCP** — build deterministic tool, optionally wrap as MCP
- **MCP auth is the strongest argument for MCP** over raw CLI — credential isolation, OAuth lifecycle management
- **Steampipe for research, AWS CLI for actions** — read-only query + write-capable CLI
- **PAI hooks can log MCP natively** — no wrapper needed, wildcard matcher catches all MCP calls
- **The litmus test:** "If you can't run it without AI, you built it wrong"
