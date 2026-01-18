# PAI Integration Design Document

**Date:** 2026-01-18
**Status:** Planning
**Related:** [Personal AI Infrastructure](https://github.com/danielmiessler/Personal_AI_Infrastructure)

---

## Overview

This document captures design decisions for integrating PAI (Personal AI Infrastructure) patterns with Imladris and curu-skills.

## Key Insight

PAI provides **structure and methodology**, not just code. The value is in:
- The Algorithm (scientific method for task execution)
- Decision Hierarchy (when to use code vs AI)
- Memory architecture (capturing learnings)
- Hook taxonomy (lifecycle events)
- Skill format (AI-readable routing)

---

## The Three Layers

```
┌─────────────────────────────────────────────────────────────┐
│  PAI (framework) - INSTALLED, NOT MODIFIED                  │
│  - The Algorithm, memory, response format                   │
│  - Core hooks (LoadContext, SecurityValidator)              │
│  - Core skills (CORE, THEALGORITHM)                         │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│  curu-skills (custom skills) - FOLLOWS PAI STRUCTURE        │
│  - Domain capabilities                                      │
│  - SKILL.md files that route to tools                       │
│  - AI-facing documentation                                  │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│  Imladris (working environment) - DETERMINISTIC             │
│  - Infrastructure (Terraform, Nix)                          │
│  - Scripts (auth-keeper, cloud-assume, etc.)                │
│  - Hooks (environment checks, security gates)               │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Principles

### 1. Decision Hierarchy

When deciding HOW to solve something:

```
Goal → Code → CLI → Prompt → Agent
```

Go as far LEFT as possible. Only move right when necessary.

| Level | Use When | Example |
|-------|----------|---------|
| Goal | Clarify what you actually want | "I need calendar sync" |
| Code | Deterministic solution exists | `gcal.sh` already does it |
| CLI | Tool exists, just run it | `gcal today` |
| Prompt | Need AI reasoning, single-shot | "Summarize these events" |
| Agent | Complex, multi-step, creative | "Plan my week around these" |

### 2. The Algorithm (Scientific Method)

When EXECUTING a task:

```
OBSERVE → THINK → PLAN → BUILD → EXECUTE → VERIFY → LEARN
```

| Phase | What Happens |
|-------|--------------|
| OBSERVE | Gather context - what's the current state? |
| THINK | Generate options - what approaches exist? |
| PLAN | Sequence work - what order, what dependencies? |
| BUILD | Define success criteria - how do we know it's done? |
| EXECUTE | Do the work |
| VERIFY | Test against success criteria |
| LEARN | Capture insights for next time |

**Key:** BUILD comes before EXECUTE. Define "done" before starting.

### 3. Hook Lifecycle

When Claude Code runs:

```
SessionStart → [work] → PreToolUse → [tool runs] → PostToolUse → [more work] → SessionStop
```

| Hook | Fires When | Purpose |
|------|------------|---------|
| SessionStart | Conversation begins | Load identity, context, rules |
| PreToolUse | Before any tool | Security validation, gating |
| PostToolUse | After tool completes | Capture results, logging |
| SessionStop | Conversation ends | Save learnings, cleanup |

---

## Separation of Concerns

### What Goes Where

| Component | Location | Why |
|-----------|----------|-----|
| `auth-keeper.sh` | Imladris | Deterministic script |
| `cloud-assume.sh` | Imladris | Deterministic script |
| `imladris-init.sh` | Imladris | Deterministic script |
| Environment hooks | Imladris | Infrastructure concerns |
| `imladris/SKILL.md` | curu-skills | AI routing to scripts |
| Algorithm enforcement | curu-skills | AI behavior |
| PAI core | ~/.claude | Installed framework |

### Hooks Are Deterministic

Hooks are code that Claude Code (the application) executes. They are:
- TypeScript or Bash
- Deterministic (same input → same output)
- Run OUTSIDE the AI
- Fire on lifecycle events

**Therefore:** Hooks belong with Imladris (infrastructure), not with skills (AI instructions).

### Skills Are AI Instructions

Skills (SKILL.md) are what the AI reads to understand:
- What commands exist
- Where to route requests
- What tools to call

**Therefore:** Skills belong with curu-skills.

---

## Zone/Context Awareness

PAI does NOT have built-in zone/context separation. This is an Imladris addition.

### Current Implementation

```bash
# Via direnv in /data/work/.envrc
export CONTEXT=work

# Via direnv in /data/home/.envrc
export CONTEXT=home
```

### Integration with PAI

The Imladris skill reads `$CONTEXT` and routes accordingly:

```markdown
# curu-skills/imladris/SKILL.md

## Context Awareness

Check $CONTEXT before routing:
- work: Enable cloud-assume, MS365, ServiceDesk
- home: Enable personal calendar, home automation
- unset: Prompt user to cd to a context directory
```

---

## Hard Enforcement of The Algorithm

### Current State

PAI **instructs** the AI to follow The Algorithm via SKILL.md injection, but does NOT **enforce** it. There's no hook that blocks execution if BUILD phase is missing.

### Proposed Addition

Add a PreToolUse hook that gates write operations on BUILD criteria:

```typescript
// Imladris hook: BuildGate.hook.ts

const GATED_TOOLS = ['Edit', 'Write', 'Bash', 'NotebookEdit'];

if (GATED_TOOLS.includes(ctx.tool) && !hasBuildCriteria(ctx)) {
  return {
    block: true,
    message: 'Define success criteria (BUILD phase) before executing.'
  };
}
```

### Enforcement Levels

| Request Type | Enforcement |
|--------------|-------------|
| Read operations | None - observation is free |
| Trivial tasks | None - direct answer |
| Write operations | Require BUILD criteria |
| Standard+ tasks | Full Algorithm enforcement |

---

## TODO Items

### High Priority

- [ ] **Design Algorithm enforcement hook** - Gate EXECUTE on BUILD criteria
- [ ] **Create Imladris skill** - SKILL.md that routes to imladris scripts
- [ ] **Define hook placement** - Which hooks go in Imladris vs curu-skills
- [ ] **Add zone awareness to skill routing** - Respect CONTEXT env var

### Medium Priority

- [ ] **Document PAI installation** - How to install PAI core on Imladris
- [ ] **Create memory capture for Imladris operations** - Log cloud access, auth events
- [ ] **Design skill structure for curu-skills** - PAI-compliant format

### Low Priority

- [ ] **Contribute zones concept to PAI** - Propose as community pack
- [ ] **Add verification hooks** - Check VERIFY phase happened after EXECUTE

---

## File Structure (Proposed)

### Imladris Repository

```
imladris/
├── scripts/              # Deterministic CLI tools (unchanged)
│   ├── auth-keeper.sh
│   ├── cloud-assume.sh
│   └── imladris-init.sh
├── hooks/                # Claude Code hooks (NEW)
│   ├── EnvCheck.hook.ts      # Is LUKS mounted? BWS connected?
│   ├── ContextLoader.hook.ts # Load CONTEXT from env
│   └── CloudGate.hook.ts     # Enforce cloud-assume before aws/az
├── infrastructure/       # Terraform (unchanged)
└── nix/                  # Environment (unchanged)
```

### curu-skills Repository

```
curu-skills/
├── imladris/             # Skill for Imladris operations
│   ├── SKILL.md          # Routes to imladris scripts
│   └── Workflows/
│       ├── CloudAccess.md
│       └── EnvironmentSetup.md
├── algorithm/            # Algorithm enforcement (if not in PAI)
│   ├── SKILL.md
│   └── hooks/
│       └── BuildGate.hook.ts
└── [other skills]/
```

### Installation Target

```
~/.claude/
├── skills/
│   ├── CORE/             # PAI (installed)
│   ├── THEALGORITHM/     # PAI (installed)
│   ├── imladris/         # From curu-skills
│   └── [other skills]/   # From curu-skills
├── hooks/
│   ├── LoadContext.hook.ts      # PAI
│   ├── SecurityValidator.hook.ts # PAI
│   ├── EnvCheck.hook.ts         # From Imladris
│   ├── ContextLoader.hook.ts    # From Imladris
│   ├── CloudGate.hook.ts        # From Imladris
│   └── BuildGate.hook.ts        # From curu-skills
└── MEMORY/               # PAI memory structure
```

---

## Open Questions

1. **Algorithm enforcement scope** - Should it apply to all sessions or just certain contexts?
2. **Memory integration** - Should Imladris operations write to PAI MEMORY or separate logs?
3. **Skill discovery** - How does AI know about Imladris skill without explicit invocation?
4. **Update mechanism** - How to update Imladris hooks when scripts change?

---

## References

- [PAI GitHub](https://github.com/danielmiessler/Personal_AI_Infrastructure)
- [PAI Algorithm](https://github.com/danielmiessler/Personal_AI_Infrastructure/tree/main/Packs/pai-algorithm-skill)
- [PAI Hook System](https://github.com/danielmiessler/Personal_AI_Infrastructure/tree/main/Packs/pai-hook-system)
- [Claude Code Hooks Documentation](https://docs.anthropic.com/claude-code/hooks)
