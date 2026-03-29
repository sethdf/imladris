---
sidebar_position: 6
---

# PAI Configuration

> **Origin: PAI (upstream)** — Everything in this section is part of the [PAI system](https://github.com/danielmiessler/PAI). It is synced from PAI upstream and is not imladris-specific. It would be present in any PAI installation.

`pai-config/` contains the PAI layer — the hooks, skills, and agents that power Claude Code's behavior on imladris.

[📁 View source → `pai-config/`](https://github.com/sethdf/imladris/tree/main/pai-config)

## Hooks

Hooks fire automatically in response to Claude Code events (tool calls, session start/stop, file edits).

[📁 View source → `pai-config/hooks/`](https://github.com/sethdf/imladris/tree/main/pai-config/hooks)

| Hook | Fires On | What it does | Source |
|------|----------|-------------|--------|
| **PrdSync.hook.ts** | Write/Edit of PRD.md | Syncs Algorithm PRD frontmatter + criteria to `work.json` dashboard | [📄](https://github.com/sethdf/imladris/blob/main/pai-config/hooks/PrdSync.hook.ts) |
| **StateSnapshot.hook.ts** | Session stop | Captures current work state to persistent JSON for session recovery | [📄](https://github.com/sethdf/imladris/blob/main/pai-config/hooks/StateSnapshot.hook.ts) |
| **McpLogger.hook.ts** | MCP tool calls | Logs all MCP tool calls to `mcp-calls.jsonl` for activity reporting | [📄](https://github.com/sethdf/imladris/blob/main/pai-config/hooks/McpLogger.hook.ts) |
| **McpSecurityValidator.hook.ts** | MCP tool calls | Validates MCP calls against allowlist — blocks unauthorized tool use | [📄](https://github.com/sethdf/imladris/blob/main/pai-config/hooks/McpSecurityValidator.hook.ts) |
| **ContextCompaction.hook.ts** | Context limit approach | Summarizes prior context to prevent context overflow during long sessions | [📄](https://github.com/sethdf/imladris/blob/main/pai-config/hooks/ContextCompaction.hook.ts) |
| **CrossWorkstreamLearning.hook.ts** | Session end | Extracts learnings from current session and propagates to MEMORY | [📄](https://github.com/sethdf/imladris/blob/main/pai-config/hooks/CrossWorkstreamLearning.hook.ts) |

## Skills

Skills are invocable prompt programs — specialized capabilities called by the Algorithm during BUILD/EXECUTE phases.

[📁 View source → `pai-config/skills/`](https://github.com/sethdf/imladris/tree/main/pai-config/skills)

Key skill categories available:

| Category | Skills |
|----------|--------|
| **Research** | Research, ClaudeResearcher, GeminiResearcher, PerplexityResearcher, GrokResearcher, CodexResearcher |
| **Thinking** | FirstPrinciples, IterativeDepth, Council, BeCreative, Science |
| **Security** | Security, WebAssessment, Recon, RedTeam, OSINT, PromptInjection |
| **Development** | Engineer, CreateCLI, CreateSkill, Cloudflare, Browser, Evals |
| **Content** | Art, Media, ExtractWisdom, Fabric, Documents, Parser |
| **Infrastructure** | PAI, PAIUpgrade, Telos, USMetrics, AnnualReports |

## Agents

Custom agent definitions with specialized roles, voices, and domain expertise.

[📁 View source → `pai-config/agents/`](https://github.com/sethdf/imladris/tree/main/pai-config/agents)

| Agent | Specialization |
|-------|---------------|
| **Algorithm** | PAI Algorithm execution and ISC generation |
| **Architect** | System design, distributed systems, CloudFormation |
| **Engineer** | Principal-level implementation with TDD |
| **Designer** | UX/UI design, accessibility, shadcn/ui |
| **Intern** | High-agency generalist for complex multi-domain problems |
| **Pentester** | Offensive security, vulnerability assessment |
| **QATester** | Quality assurance via browser automation |
| Various Researchers | Claude, Codex, Gemini, Grok, Perplexity — parallel research |
