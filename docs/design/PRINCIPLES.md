# Guiding Principles

## Purpose Statement

> A reproducible Linux cloud workstation that captures all inputs from life and work, surfaces actionable items, organizes by context (workspaces), and provides frictionless AI-assisted tools to act on them.

---

## Core Concepts

| Term | Definition |
|------|------------|
| **Zone** | Top-level context (work, home) |
| **Mode** | Activity type within a zone (tasks, comms, projects, research, adhoc) |
| **Workspace** | Zone + Mode combination (e.g., work:tasks) |

---

## Workspaces

```
WORK                              HOME
├── work:tasks                    ├── home:tasks
├── work:comms                    ├── home:comms
├── work:adhoc                    ├── home:adhoc
├── work:projects                 ├── home:projects
└── work:research                 └── home:research
```

**10 total workspaces** - 5 modes × 2 zones

- Zone determines *whose* context (work vs personal)
- Mode determines *what* activity
- Zone is implicit from source and current workspace
- Workspace is explicit and unambiguous in the UI

---

## The Three Pillars

| Pillar | What it does | What it doesn't do |
|--------|--------------|-------------------|
| **Workspaces** | Context organization, zone/mode switching | Complex workflow automation |
| **Intake** | Capture all inputs → unified inbox | Auto-respond, act on your behalf |
| **Tools** | Quick access to skills, auth just works | Build custom integrations per-service |

---

## Boundaries

**In Scope**
- Collector and workspace
- Aggregates and presents
- You decide and act

**Out of Scope**
- Outbound automation (bots replying, scheduled actions)
- Multi-instance / HA / scaling
- Building a task/project management system

---

## Principle 1: Context Switching is Expensive

Research shows 23 minutes average recovery time after interruption. Zone switches cost more than mode switches within a zone.

**Design implications:**
- Make zone switches deliberate
- Make mode switches easy
- Visual cues reduce reorientation time
- Persistence eliminates reconstruction cost

---

## Principle 2: Modes Map to Cognitive Action Types

| Mode | Action Type | GTD Context |
|------|-------------|-------------|
| tasks | Execute | @execute |
| comms | Communicate | @communicate |
| projects | Create | @create |
| research | Learn | @learn |
| adhoc | Quick/flexible | @quick |

Each mode groups similar cognitive work, reducing switching cost within the mode.

---

## Principle 3: Interstitial Journaling on Transitions

On zone or mode switch, prompt for a brief context dump:

```
[18:15] Leaving: work:tasks
Unfinished: _______
Next time: _______
```

Takes 30 seconds, saves 23+ minutes of "where was I?" on return.

---

## Principle 4: Friction is Intentional

| Transition | Friction Level | Why |
|------------|----------------|-----|
| Start working | Low | Fast entry, no barriers |
| Within mode | Low | Tools at hand, flow state |
| Mode → Mode (same zone) | Medium | Brief pause, context shift |
| Zone → Zone | Higher | Dump context, deliberate switch |

Low friction to start. Low friction within. Higher friction to leave.

---

## Principle 5: Deep vs Shallow Work Separation

| Shallow (batch, time-box) | Deep (protect, extend) |
|---------------------------|------------------------|
| tasks | projects |
| comms | research |
| adhoc | |

- Shallow work: process in windows, then close
- Deep work: protect time blocks, minimize interruption
- Don't mix shallow and deep in the same session

---

## Principle 6: Working Memory Limits

Cognitive research shows 3-5 items is the real working memory limit.

**Design implications:**
- 5 modes is optimal (matches cognitive limit)
- 2 zones is manageable
- 10 total workspaces is within bounds
- Always show current context (offload to environment)
- Never rely on human memory for state

---

## Principle 7: Plain Text Everything

- Greppable - find anything instantly
- Scriptable - automate with shell
- Version controlled - full history with git
- Composable - pipe to other tools
- Portable - no vendor lock-in

> "Productivity tools should help you finish tasks, not organize them."

Avoid tools that become friction themselves.

---

## Principle 8: Persistence Over Memory

| What | Persisted How |
|------|---------------|
| Session state | tmux (detach/reattach) |
| Context notes | Interstitial journal |
| Tasks | Plain text files |
| Inputs | Intake database |
| Auth | Lazy-loaded, auto-refreshed |

Never rely on human memory. The system remembers so you don't have to.

---

## Principle 9: Defaults Over Decisions

- Workspace entry has sensible defaults
- Mode switching requires minimal thought
- "Just start" should always be possible
- Reduce choices at each moment

Every decision is cognitive load. Eliminate unnecessary decisions.

---

## Principle 10: Visual Cues = Cognitive Offloading

| Signal | Implementation |
|--------|----------------|
| Prompt prefix | `[work:tasks]` or similar |
| Status bar | Zone + mode always visible |
| Colors | Zone = color family |
| Window names | Explicit: `work:tasks` |

Immediate orientation on entry. No guessing "where am I?"

---

## Principle 11: Batch Shallow Work

- `comms` collects all communication
- `tasks` collects all actionable items
- Process in windows, then close
- Don't leave shallow work modes open as distraction

Inbox zero applies to modes, not just email.

---

## Principle 12: Zone Entry = Room Entry

Switching zones should feel deliberate, like entering a different room.

- Physical cues (colors, sounds, prompts)
- Brief transition ritual (interstitial note)
- Clear separation of concerns
- Work stays in work, home stays in home

---

## System Architecture

```
Infrastructure (Terraform)
    └── Single cloud instance, reproducible, encrypted storage

Workspaces (tmux + shell)
    └── Zone/mode organization, visual signaling, persistence

Intake (aggregator)
    └── Capture all inputs, preserve source/zone context

Triage (surfacing)
    └── Surface actionable items from captured inputs

Tools (PAI + Claude Code)
    └── Skills for acting on items, lazy auth

PAI Foundation
    └── TELOS (goals), Algorithm (execution), Memory (context)
```

---

## What PAI Provides vs What We Build

**PAI provides:**
- The AI brain (skills, memory, hooks)
- Goal context (TELOS)
- Execution methodology (Algorithm)
- Response format standards

**We build around PAI:**
- Workspace organization (zones/modes)
- Intake aggregation (external sources → inbox)
- Context signaling (status bar shows workspace)
- Transition rituals (interstitial journaling)
