---
sidebar_position: 9
---

# Kaizen Learning Loops

**Version:** 0.1
**Date:** 2026-04-15
**Status:** Draft — composable self-improvement stack for PAI/Imladris code work

---

## Overview

A three-layer learning stack that composes best-in-class open-source frameworks to give PAI's code-building path genuine continuous-improvement behavior. Each layer owns a distinct kaizen concern, the pieces stay swappable, and the integration is fully additive to PAI and Imladris — no forking, no rewrites.

- **Orchestration** — Ruflo (already integrated via `scripts/pai-ruflo-bridge.ts`)
- **Cross-session skill kaizen** — Hermes Agent (Nous Research, MIT)
- **Prompt-policy kaizen** — DSPy + GEPA (Genetic-Pareto optimizer, ICLR 2026 oral)

The guiding idea: most "AI that learns" frameworks stop at vector memory. Real kaizen requires (1) honest measurement of failure, (2) a root-cause step, (3) a durable policy change. This spec wires all three into Imladris.

---

## Design Principles

### One layer, one job
Orchestration, cross-session memory, and policy optimization are three different problems. Any framework that starts reaching across those boundaries is a signal the wrong pick was made. Each layer is swappable in isolation.

### Additive to PAI
PAI hooks, Algorithm phases, and MEMORY writes remain unchanged. New artifacts (Hermes skill docs, GEPA candidate prompts) land in designated sidecar locations, never replacing existing files. If any of the three pieces is disabled, PAI and Imladris degrade gracefully to current behavior.

### Scoring first, integration second
No framework is wired in until its reward signal is defined. Retrieval-theater — memory that gets written but never drives a measurable delta — is explicitly out of scope. Phase 0 exists precisely for this.

### Human-gated policy changes
GEPA can propose prompt diffs; it cannot merge them. The loudest learning loop (modifying the Algorithm itself) is the one most prone to drift, so it remains PR-gated.

### Selection rationale

| Category | Pick | Why | Alternatives considered |
|---|---|---|---|
| Orchestration / swarm | **Ruflo** | Already integrated via `pai-ruflo-bridge.ts`; active v3 self-learning; invoked from Algorithm BUILD | AutoGen, CrewAI, OpenHands, OpenAI Agents SDK |
| Cross-session skill kaizen | **Hermes Agent** | MIT, released 2026-02-25; auto-writes reusable skill docs from completed tasks; skills self-improve through usage; fits PAI MEMORY paradigm | Letta / MemGPT, Mem0, Voyager pattern |
| Prompt-policy kaizen | **DSPy + GEPA** | GEPA is now a DSPy optimizer (ICLR 2026 oral); 35× fewer rollouts than MIPROv2; 13% lift over MIPROv2, 20% over GRPO | TextGrad, Trace, MIPROv2 alone, APE |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    PAI Algorithm v3.7.0                       │
│                                                               │
│   OBSERVE ─▶ PLAN ─▶ [BUILD] ─▶ VERIFY ─▶ PERSIST            │
│      │        │         │          │          │               │
└──────┼────────┼─────────┼──────────┼──────────┼───────────────┘
       │        │         │          │          │
       │        │         ▼          │          │
       │        │    ┌─────────┐     │          │
       │        │    │  Ruflo  │     │          │
       │        │    │  swarm  │     │          │
       │        │    └─────────┘     │          │
       │        │                    │          │
       ▼        ▼                    ▼          ▼
  ┌───────────────────┐       ┌───────────────────┐
  │ Hermes skill      │       │ Reward signals    │
  │ library (read)    │       │ (tests, accept,   │
  │                   │       │  rework, conf)    │
  └─────────┬─────────┘       └─────────┬─────────┘
            │                           │
            │   ┌───────────────────────┘
            │   │
            ▼   ▼
    ┌───────────────────┐           ┌────────────────────┐
    │ Hermes skill      │           │  DSPy + GEPA       │
    │ writer (post-run, │           │  (weekly batch,    │
    │ positive-reward   │──signals─▶│  optimizes phase   │
    │ only)             │           │  prompts)          │
    └─────────┬─────────┘           └─────────┬──────────┘
              │                               │
              ▼                               ▼
       ┌────────────────────────────────────────────┐
       │          PAI MEMORY + Algorithm repo       │
       │   (skills, signals, candidate prompt PRs)  │
       └────────────────────────────────────────────┘
```

---

## Phases

### Phase 0 — Scoring signal (PREREQUISITE, no framework integrations yet)

- Define the reward function for Algorithm runs: tests pass (Y/N), user accepted without correction (Y/N), investigation confidence (float, when applicable), rework count (int).
- Extend existing session-signal capture to persist these per Algorithm run, keyed by run id.
- Backfill from recent runs where possible for initial training data.

**Acceptance:** every BUILD-phase run writes a row with all four fields into the signals store. Queryable by date range and Algorithm version.

### Phase 1 — Hermes skill library (read path)

- Vendor Hermes Agent alongside Ruflo under `~/.claude/PAI/agents/hermes/` (separate bridge; not merged with Ruflo).
- Store skill docs in `~/.claude/PAI/skills/hermes/` (distinct from existing PAI skills to avoid namespace collision).
- Algorithm OBSERVE phase queries Hermes for skills matching the task context; top-K skills injected into the PLAN prompt.

**Acceptance:** skill retrieval working end-to-end; zero modifications to existing Algorithm phase files beyond the OBSERVE/PLAN prompt blocks.

### Phase 2 — Hermes skill writer (write path)

- Post-BUILD hook distills the completed run (diff, test results, reward signals) into a new or updated Hermes skill doc.
- Write is gated on Phase 0 reward: only successful runs produce skills. Failed runs are logged for GEPA but do not pollute the skill library.

**Acceptance:** a full successful Algorithm run produces a skill doc; failed runs do not; round-trip works (next similar task retrieves the newly-written skill).

### Phase 3 — DSPy + GEPA prompt-policy optimization

- Scheduled weekly job reads last N Algorithm runs plus their reward signals.
- DSPy pipeline treats each Algorithm phase prompt (OBSERVE / PLAN / BUILD / VERIFY) as an optimizable module.
- GEPA proposes candidate prompt diffs based on observed reward gaps.
- Candidates land as a **pull request** against `~/.claude/PAI/Algorithm/` (e.g. v3.7.0 → v3.8.0-candidate) for human review. Never auto-merged.

**Acceptance:** first weekly run produces a reviewable diff; process for reviewing and versioning is documented; at least one candidate phase prompt accepted and version-bumped by week 4.

### Phase 4 — Close the loop

- Track reward-signal trend over time (median reward by week).
- Dashboard panel in docs-site showing trend.
- If no statistically significant improvement after 4 weeks post-Phase-3, review whether the scoring signal is the actual bottleneck rather than adding more frameworks.

**Acceptance:** dashboard live; monthly review note captured in `context/memory/`.

---

## Risks & Tradeoffs

- **Three moving parts to maintain.** Each must earn its keep. If the reward signal (Phase 0) is weak, all three layers collapse into retrieval-theater. Phase 0 is the load-bearing prerequisite.
- **Hermes + Ruflo overlap.** Both claim self-learning. Explicit boundary: Ruflo = execution + short-term coordination memory; Hermes = durable cross-run skill library. If overlap becomes friction, drop Ruflo's internal memory and keep only its swarm orchestration.
- **GEPA auto-modifying Algorithm prompts.** PR-gated, never auto-merged. This is the riskiest learning loop; drift here silently degrades every future run.
- **Language split.** Hermes + Ruflo on Node/TS; DSPy + GEPA on Python. The optimization job is a standalone Python process, not in-band with PAI. Extra runtime, but keeps responsibilities clean.
- **Dependency surface.** All four frameworks are MIT-licensed.

---

## Non-Goals

- Replacing any existing PAI component.
- Merging Hermes skills into the existing PAI skills directory.
- Running GEPA continuously; it is a batch/scheduled optimizer by design.
- Introducing a unified "agent framework" meta-layer above all three.
- Training any custom models.

---

## Open Questions

- Reward signal granularity: per-phase or per-run? Per-phase gives GEPA a better signal but requires more plumbing. Resolve in Phase 0.
- Skill doc ownership: does Hermes's skill format align with PAI's closely enough to unify later, or do they stay separate permanently? Decide after Phase 2 data.
- Does Ruflo v3's claimed self-learning conflict with the Hermes skill library? Test empirically in Phase 1 before investing in Phase 2.

---

**Related:**

- PAI Algorithm v3.7.0 — `~/.claude/PAI/Algorithm/v3.7.0.md`
- Ruflo integration — `scripts/pai-ruflo-bridge.ts`
- PAI MEMORY — `~/.claude/projects/*/memory/`
