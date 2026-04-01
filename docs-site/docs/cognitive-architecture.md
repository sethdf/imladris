---
sidebar_position: 2
---

# Cognitive Architecture

> **How to read this document:** This docs site tells you *what* each component does and *where* to find it. This document tells you *why* everything is the way it is — the principles behind every design decision, grounded in neuroscience, applied through PAI, and implemented in imladris. Use it to evaluate whether a proposed change is principled or unprincipled.

---

## Part I: The Cognitive Science Foundation

### Why this architecture exists at all

The entire PAI+imladris system is a response to a single physical constraint: **human conscious bandwidth is approximately 10 bits per second**.

This is not a metaphor. Researchers Jieyu Zheng and Markus Meister (Caltech, *Neuron* 2024) measured behavioral information throughput across dozens of tasks — reading, typing, chess, piano, mental arithmetic — and consistently found a ceiling of roughly 10 bits/sec for conscious behavioral output. Visual input to the retina runs at ~10 million bits/sec. Individual neurons fire at rates that, in aggregate, carry orders of magnitude more information than 10 bits/sec. But the channel capacity of the conscious decision-making pipeline — the part where you actually *choose* something — is approximately 10 bits/sec.

An AI processes millions of tokens per second. The human-AI collaboration is therefore not between two entities of similar capacity. It is between a 10-bit/sec judgment machine and a million-bit/sec pattern machine. **The optimal workflow is not "think faster." It is: offload bandwidth-intensive processing to the AI and reserve your 10 bits/sec for judgment, direction, and verification.**

Everything else in this document follows from this constraint.

### The Extended Mind (Clark & Chalmers, 1998)

Andy Clark and David Chalmers argued in "The Extended Mind" that cognitive processes are not confined to the skull. Their "parity principle": if an external process does the same functional work that an internal brain process would do, it counts as part of the cognitive system. A notebook that Otto uses to compensate for memory loss is not a tool that *assists* his memory — it *is* his memory, functionally speaking.

PAI's MEMORY system, PRDs, ISC criteria, and the Algorithm are not tools that help Seth think. They are constituents of how Seth thinks. The boundary of Seth's cognition extends into `~/.claude/MEMORY/`. This is not poetic — it is the literal claim of extended mind theory, and it has operational consequences:

- **MEMORY files are not backups.** They are cognitive state. Losing them is losing memory.
- **PRD criteria are not documentation.** They are externalized working memory. Skipping them is not saving time — it is operating with degraded cognition.
- **The Algorithm is not a process.** It is scaffolding for the analytical reasoning that Seth's prefrontal cortex cannot sustain at AI bandwidth.

### Cognitive Externalization as Evolution

Homo sapiens brains have been *shrinking* for approximately 10,000 years — since the advent of writing, institutions, and complex social knowledge structures. The prevailing explanation (consistent with Rosenzweig's enriched environment work): brains optimize for interfacing with external cognitive systems rather than raw individual computation when those external systems are reliable. Writing externalizes declarative memory. Law externalizes social norms. Institutions externalize coordination. AI externalizes working memory and analytical bandwidth.

PAI is the latest accretion layer in a very old evolutionary process. This has a concrete implication: **the system is not augmenting Seth's cognition — it is becoming part of Seth's cognitive architecture**. Designing it carelessly is not a technical mistake; it is a cognitive hygiene failure.

### Dreams, MEMORY, and the NEXTUP Model

Stickgold and Walker's NEXTUP (Network Exploration To Understand Possibilities) theory proposes that dreams serve to explore weak associations between memories, consolidating useful connections and preventing the brain from overfitting to recent experience. Noisy, unexpected input during dreaming helps generalization.

The PAI MEMORY system serves an analogous function for working knowledge. The act of writing findings to MEMORY — forcing externalization, structure, and commitment — is itself cognitive processing. Sessions that end without MEMORY updates are like dreamless sleep: no consolidation, no connection-building, no anti-overfitting. The weekly pattern synthesis (`LearningPatternSynthesis.ts`) is the closest operational analog to the dream consolidation cycle.

The implication: AI that surprises and challenges is cognitively healthier than AI that only confirms. The Algorithm's THINK phase (premortem, riskiest assumptions) is intentional cognitive friction.

### The Corpus Callosum Principle

Carl Sagan: *"The search for patterns without critical analysis, and rigid skepticism without a search for patterns, are the antipodes of incomplete science."*

The corpus callosum connects the brain's hemispheres, mediating between pattern-recognition and analytical scrutiny. Neither alone produces good science; the combination does. This maps directly to the human-AI division of labor:

- **AI excels at:** Broad pattern recognition, synthesis across large corpora, rapid hypothesis generation
- **Humans excel at:** Critical analysis, goal-setting, verification, judgment about what matters

The Algorithm's structure enforces this division. OBSERVE and BUILD are bandwidth-intensive (AI-dominant). THINK, VERIFY, and LEARN are judgment-intensive (human-dominant via ISC pre-commitment and verification gates).

### The Free Energy Principle (Friston)

Karl Friston's Free Energy Principle holds that all biological agents operate by minimizing surprise — maintaining a generative model of the world, predicting incoming data, and either updating the model (perception) or acting to make the world conform to predictions (action). Active inference: agents restructure their environment to reduce the gap between expected and actual states.

PAI's ISC + Verification architecture is a direct software implementation of active inference:
1. **Define Ideal State** (prediction / expected outcome)
2. **Execute** (act to move the world toward the prediction)
3. **Verify** (measure the delta between prediction and actual)
4. **Learn** (update the model based on the delta)

The "free energy" being minimized is the gap between ISC criteria and current reality. Every Algorithm run is an active inference cycle.

---

## Part II: The Four Bedrock Principles

From first principles analysis, four hard constraints drive everything:

### Bedrock-1: The Bandwidth Principle
> *Human conscious bandwidth is fixed at ~10 bits/sec. Every design decision must preserve that bandwidth for judgment and redirect everything else to the machine.*

**What it demands:**
- External working memory (PRDs, ISC, current-work.json)
- Automated data collection (Windmill cron, webhooks)
- Agent delegation for bandwidth-intensive work
- Session summaries, not session transcripts, for context recovery

**What violates it:**
- Doing manually what a script or agent can do
- Holding task state in your head instead of a PRD
- Reading raw logs instead of a structured report

### Bedrock-2: The Persistence Principle
> *Any insight, decision, or context not explicitly written to durable storage is permanently lost at session end.*

**What it demands:**
- MEMORY writes during (not after) sessions
- PRD as write-ahead log (not end-of-session summary)
- Hooks that fire on session end to capture state
- Zero-context-loss as a first-class design requirement, not a nice-to-have

**What violates it:**
- Completing a multi-hour investigation without writing findings to MEMORY
- "I'll document it later"
- Relying on conversation history (30-day retention, then gone)

### Bedrock-3: The Falsifiability Principle
> *Any AI output not verified against a pre-committed criterion is an assertion without evidence — epistemically a hallucination regardless of confidence.*

**What it demands:**
- ISC criteria defined BEFORE execution begins (not rationalized after)
- VERIFY phase in every Algorithm run
- Distinction between "done" and "verified done"
- Anti-criteria (what must NOT happen) treated as first-class

**What violates it:**
- Declaring something "complete" without checking criteria
- Skipping the VERIFY phase when pressed for time
- Writing ISC criteria after seeing the output ("I built X, so ISC-1 is: X exists")

### Bedrock-4: The Alignment Principle
> *AI has no intrinsic goals. Without explicit bounded objectives, it optimizes for the wrong thing. Every interaction must carry pre-committed criteria for what success looks like.*

**What it demands:**
- ISC before any work begins
- Steering rules (AISTEERINGRULES.md) loaded at every session
- Explicit scope boundaries (what is and isn't in scope)
- Anti-criteria documenting what must not happen

**What violates it:**
- "Just do the right thing" without criteria
- Open-ended requests without effort level or scope
- Assuming the AI knows what "done" means

---

## Part III: PAI's 16 Principles — Bedrock vs. Derived

PAI has 16 founding principles. Four are bedrock (cannot be derived from anything else). The rest are derived — each follows necessarily from the bedrock principles.

### The Bedrock Four

| # | Principle | Bedrock Justification |
|---|-----------|----------------------|
| 15 | **Science as Cognitive Loop** | *IS* the Falsifiability Principle instantiated in software |
| 13 | **Custom Memory System** | *IS* the Persistence Principle instantiated in software |
| 2 | **Continuously Upgrading Algorithm** | Falsifiability (can fail → can improve) + Alignment (explicit criteria for improvement) |
| 4 | **Scaffolding > Model** | Bandwidth Principle (scaffolding extends cognitive capacity; raw model doesn't) |

### The Derived Principles (and what they derive from)

| # | Principle | Derives from |
|---|-----------|-------------|
| 7 | Spec/Test/Evals First | Science as Cognitive Loop (falsifiability before execution) |
| 5 | As Deterministic as Possible | Scaffolding > Model (determinism is the scaffolding property that survives model variation) |
| 6 | Code Before Prompts | Scaffolding + Deterministic (code IS deterministic scaffolding) |
| 8 | UNIX Philosophy | Scaffolding + Code (composable deterministic pieces > monolithic prompt) |
| 10 | CLI as Interface | Deterministic + UNIX (CLI = maximally testable, loggable, scriptable) |
| 11 | Goal→Code→CLI→Prompts→Agents | All of the above, in dependency order |
| 12 | Custom Skill Management | Memory + UNIX (skills are composable, persistent procedural memory) |
| 14 | Custom Agent Personalities | Scaffolding + Alignment (structured delegation with explicit behavioral constraints) |
| 3 | Clear Thinking + Prompting | Alignment (garbage in → garbage out; clarity is alignment at the input layer) |
| 9 | ENG/SRE Principles | Scaffolding > Model (production AI = production software; treat it as such) |
| 1 | Customization of Agentic Platform | Bandwidth + Alignment (personalization = reducing the overhead of alignment at every interaction) |
| 16 | Permission to Fail | Falsifiability (a system that can admit failure is a system that can be falsified) |

---

## Part IV: The Algorithm as Scientific Method

The PAI Algorithm is not a process checklist. It is the scientific method instantiated as a software execution loop.

```
Scientific Method          PAI Algorithm
────────────────────       ────────────────────────────
Define question         →  OBSERVE: request reverse engineering
Literature review       →  OBSERVE: context recovery, capability selection
Form hypothesis         →  OBSERVE: ISC criteria (pre-committed success criteria)
Identify risks          →  THINK: premortem, riskiest assumptions
Design experiment       →  PLAN: technical approach, prerequisite validation
Run experiment          →  BUILD + EXECUTE: invoke capabilities, perform work
Measure results         →  VERIFY: test each ISC criterion against actual state
Record findings         →  LEARN: what to do differently, update algorithm
Repeat                  →  Next iteration (Ideal State Criteria reset)
```

**ISC as scientific hypothesis:** Every ISC criterion is a falsifiable statement about the end state. "ISC-3: The session container connects to the Docker network without a socket mount" can pass or fail — it is not a subjective judgment. Pre-commitment to these criteria before execution is the equivalent of pre-registering a study: it prevents post-hoc rationalization of results.

**The ISC Count Gate** (cannot exit OBSERVE with fewer ISC than the effort tier floor) is a falsifiability enforcement mechanism. Fat criteria ("everything works") cannot be falsified. Atomic criteria ("container starts with --rm flag present in docker inspect output") can.

**VERIFY phase as replication:** Running each criterion against the actual output is the equivalent of replication — you are not trusting that it worked, you are checking that it worked. The gap between "I built this" and "this passes its criteria" is precisely the gap that hallucinations live in.

---

## Part V: The Intelligence Cycle — PAI's Operational Heartbeat

The four-stage Intelligence Cycle (adapted from intelligence tradecraft) is how imladris processes all external information:

```
COLLECT ──→ CORRELATE ──→ SURFACE ──→ LEARN
  ↑                                     │
  └─────────────────────────────────────┘
  (learning improves what/when/how we collect)
```

This is the Scientific Method applied to operational data. Each stage maps to brain function and to specific imladris scripts:

### COLLECT — Sensory Input Layer

The brain receives ~1 billion bits/sec of sensory data. Most never reaches consciousness; the sensory cortices pre-filter before passing anything upward. Imladris's collection layer does the same: automated scripts gather far more data than Seth ever reads, and the triage layer pre-filters before anything reaches Claude's context.

| Pattern | Mechanism | Brain Analog | Imladris Scripts |
|---------|-----------|-------------|-----------------|
| Pull (scheduled) | Windmill cron | Saccadic eye movement (active sampling) | `compliance_scan.ts`, `cost_report.ts`, `batch_triage_emails.ts` |
| Push (event-driven) | Webhooks + Slack | Startle reflex (involuntary attention capture) | `batch_triage_slack.ts`, `batch_triage_sdp.ts`, `batch_triage_telegram.ts` |
| Feed (continuous) | Polling + RSS | Background vigilance | `feed_collector.ts`, `upstream_updates.ts` |

[📁 Full script source → investigate/ and devops/](https://sethdf.github.io/imladris/windmill/investigate)

### CORRELATE — Pattern Recognition Layer

Raw sensory data is meaningless without pattern recognition across time, space, and domain. Imladris's correlation layer is the corpus callosum — it connects data points that arrived via different channels.

| Type | What | Mechanism |
|------|------|-----------|
| Same-entity | Multiple sources about the same resource | `sdp_aws_correlate.ts`, `cross_correlate.ts` |
| Same-time | Events clustering temporally | `triage_pipeline.ts` timestamp analysis |
| Same-pattern | Looks like something we've seen | `agentic_investigator.ts` + MEMORY/LEARNING search |
| Cross-domain | Different types connected | `correlate_triage.ts`, entity extraction |

The **agentic investigator** (`agentic_investigator.ts`) is the key component here: a Bedrock Converse tool-use loop that autonomously investigates alerts across up to 8 rounds using 20+ investigation tools. This is AI bounded like a scientist — it does not freestyle; it calls specific, auditable, read-only tools and reasons across their outputs.

[📁 Investigation tools → investigate/](https://sethdf.github.io/imladris/windmill/investigate)

### SURFACE — Attention Direction Layer

The brain's salience network (amygdala, anterior cingulate cortex) directs conscious attention toward what matters. Imladris's surfacing layer decides what gets sent to Seth's 10 bits/sec conscious channel.

| Mode | When | Mechanism |
|------|------|-----------|
| Proactive | You should know now | `process_actionable.ts` → Slack DM to U06H2KKCCET |
| Contextual | Related to active work | Triage QUEUE with workstream flag |
| Retrospective | What happened | `activity_report.ts`, `sdp_morning_summary.ts` |
| On-demand | You asked | MCP tools via Claude session |

**The Slack DM routing constraint** (`U06H2KKCCET` — never `#general`, never a channel) is not a preference. It is a bandwidth conservation rule: Seth's attention is the bottleneck; broadcasting to channels where it might be missed wastes it. All surfacing goes directly to the person who needs to know.

### LEARN — Model Update Layer

After each cycle, the system updates its model of the world — improving what it collects, how it correlates, when it surfaces. This is the feedback loop that makes the cycle compound over time.

| Type | Mechanism |
|------|-----------|
| Per-event | PRD decisions + log |
| Session-level | MEMORY writes, LEARNING/ALGORITHM |
| Cross-session patterns | `LearningPatternSynthesis.ts`, rating signals |
| Triage calibration | `triage_feedback.ts` → `triage-calibration.json` |
| System improvement | PAI Algorithm LEARN phase reflections |

---

## Part VI: How Imladris Extends PAI

PAI is the universal substrate: Algorithm, MEMORY, hooks, skills, agent system, delegation. Imladris is Seth's specific cognitive extension, built on that substrate. The distinction matters: **PAI components are upstream — you can upgrade PAI without touching imladris. Imladris components are additive — they give PAI's reasoning system things to reason about.**

### What imladris adds: Extended Senses

PAI without imladris is a powerful reasoning engine with no inputs except what Seth manually types. Imladris's ~45 investigation scripts (`windmill/f/investigate/`) are Claude's extended senses — read-only probes into AWS, Azure, Cloudflare, SigNoz, Sophos, Aikido, Slack, Telegram, and more.

These are explicitly bounded: every script is **read-only**. They gather; they do not act. This maps to the sensory cortices — they collect signal; the motor cortex (approval flows, remediation scripts) acts only after full Analysis and explicit approval.

### What imladris adds: Automated Nervous System

PAI without imladris requires Seth to manually trigger all data collection. Imladris's Windmill automation layer (`windmill/f/devops/`) is the automated nervous system — it runs on schedule, responds to events, and routes findings through the triage pipeline without requiring Seth's 10 bits/sec to initiate it.

The pipeline:
```
Inputs (Slack/SDP/AWS/Telegram)
    ↓
batch_triage_*.ts (Haiku classification — fast, cheap)
    ↓
agentic_investigator.ts (Bedrock Converse, 8 rounds, 20 tools)
    ↓
process_actionable.ts (SDP task creation + Slack escalation)
    ↓
approval_flow.ts (human gate for destructive actions)
    ↓
approve_remediation.ts + verify_remediation.ts
```

Every step is auditable. Every action requiring write access has a human approval gate. This is AI bounded like a scientist: hypothesize → investigate → recommend → verify, with human sign-off before any state change.

### What imladris adds: Credential and Credential Hierarchy

PAI's reasoning is only as useful as the data it can access. Imladris implements a four-layer credential hierarchy that gives Claude access to 15+ external systems without storing credentials in code or Claude's context:

```
Bitwarden Secrets (permanent source of truth)
    ↓
Windmill vault (operational cache, auto-refresh)
    ↓
EC2 IAM role (AWS access, zero stored credentials)
    ↓
MCP transport auth (automatic, not service auth)
```

The result: Claude calls a Windmill MCP tool → Windmill uses its vault → vault was populated from Bitwarden → Bitwarden credential never appears in Claude's context. The credential hierarchy is invisible to the reasoning layer, which is exactly the right design (Bedrock-4: alignment at the boundary, not in the reasoning).

### What imladris adds: Security Posture as Cognitive Immune System

The brain's immune system analogy: the blood-brain barrier (what enters), the immune response (what is detected and eliminated), and immunological memory (patterns that trigger faster response next time).

Imladris's security layer:
- **Blood-brain barrier:** `.claude` volumes mounted read-only to Windmill workers (yesterday's fix). Prompts and external content cannot write to PAI's reasoning substrate.
- **Immune response:** `SecurityValidator.hook.ts` — every write operation is confirmed with details. Prompt injection that reaches a write tool is stopped here.
- **Immunological memory:** `SECURITY/security-events.jsonl` — all security decisions logged for pattern detection.

The prompt injection threat model: external content (emails, Slack messages, alert text) enters imladris through the triage pipeline. If that content contains instructions designed to manipulate Claude's reasoning, they arrive in Claude's context during investigation. The immune system works at three layers:
1. Windmill workers can only READ Claude's configuration (no write vector)
2. SecurityValidator confirms destructive operations (human gate before any action)
3. Approval flows for all write operations (structural guard, not prompt-level guard)

---

## Part VII: The Cognitive Component Map

Every major component maps to a cognitive function:

| Component | Cognitive Analog | Brain Region Parallel |
|-----------|-----------------|----------------------|
| PAI Algorithm | Scientific method / executive function | Prefrontal cortex |
| MEMORY system | External declarative memory | Hippocampus (extended) |
| ISC / PRDs | External working memory | Dorsolateral PFC |
| Skills system | Procedural memory | Basal ganglia / cerebellum |
| Agent delegation | Cognitive offloading | Working memory relief |
| Windmill triage | Pre-conscious sensory filtering | Thalamus / reticular formation |
| MCP tools | Voluntary motor action (deterministic) | Motor cortex (pre-planned movement) |
| Hooks (session start/stop) | Circadian rhythm / sleep-wake transition | Suprachiasmatic nucleus |
| LEARNING/SIGNALS (ratings) | Dopaminergic reward signal | Basal ganglia reward circuit |
| Voice notifications | Proprioceptive feedback | Cerebellum (body state awareness) |
| SecurityValidator hook | Immune checkpoint | Blood-brain barrier |
| Bitwarden credential hierarchy | Long-term memory encryption | Memory consolidation during sleep |
| Intelligence Cycle | Perception-action loop | Sensorimotor cortex |
| Approval flows | Volitional inhibition (stopping impulsive action) | Anterior cingulate cortex |

---

## Part VIII: The Two Interfaces — One Brain, Two Doors

Imladris exposes two interfaces to Claude+PAI:

```
Terminal session (SSH → tmux → Claude Code)
    └── Deep work: full Algorithm, PRDs, code, investigation
    └── High bandwidth: can see and do anything
    └── Blocking: Seth must be at the terminal

Windmill messaging gateway (Slack → Windmill → claude -p)
    └── Ambient work: triage, classify, create SDP tasks, escalate
    └── Non-blocking: runs while Seth is doing other things
    └── Constrained: non-interactive (claude -p), approval flows for anything destructive
```

These are not two systems — they are two access patterns to the same cognitive architecture. Both use Claude Code + PAI. Both write to the same MEMORY. Both work with the same PRDs. The distinction is bandwidth and interactivity:

- **Terminal session:** Seth's 10 bits/sec is online and directing
- **Messaging gateway:** Seth's 10 bits/sec is offline; system operates within pre-committed constraints

This design is the Alignment Principle implemented at the interface level. The messaging gateway cannot do anything Seth hasn't pre-approved (via approval flows and AISTEERINGRULES).

---

## Part IX: Deterministic-First — Why MCP Comes Before CLI

The principle hierarchy for any external action:

```
1. MCP tool call (preferred)      ← deterministic, logged, bounded, tested
2. Windmill script (via MCP)      ← same as above, credential-isolated
3. CLI command                    ← deterministic, logged, but less bounded
4. AI-generated shell command     ← least deterministic, highest hallucination risk
```

**Why MCP first?** MCP tools have defined schemas (inputs and outputs), are versioned, are testable independently of the AI, and are logged by the McpLogger hook. An AI calling an MCP tool is making a structured, bounded function call. An AI generating a shell command is producing free-form text that happens to be executable — much higher variance.

**The McpLogger hook** captures every `mcp__*` tool call with arguments to `~/.claude/logs/mcp-calls.jsonl`. This is the audit trail for deterministic-first: every external action is on record. The `activity_report.ts` reads this log to generate manager-friendly summaries — a direct link from the principle to the monitoring mechanism.

---

## Part X: Principle Verification Matrix

For each bedrock principle, here is what implementation makes it real and how to verify it:

### Bandwidth Principle Verification

| What implementation makes it real | How to verify |
|----------------------------------|--------------|
| current-work.json updated by hooks (not manually) | `cat ~/.claude/MEMORY/STATE/current-work.json` — check `last_updated` timestamp |
| SessionStart hook loads context automatically | Check dashboard output at session start — no manual searching required |
| Windmill collects data on schedule without Seth initiating | `windmill jobs list` — verify cron jobs ran in last 24h |
| Agent delegation for bandwidth-intensive tasks | Check PRD history — complex tasks use multiple agents, not single-thread prompting |

### Persistence Principle Verification

| What implementation makes it real | How to verify |
|----------------------------------|--------------|
| MEMORY written during sessions | `ls -lt ~/.claude/MEMORY/WORK/` — check recency of PRD updates vs session times |
| Hooks fire on session end | Check `LEARNING/ALGORITHM/` for recent entries after each significant session |
| Zero tolerance for context loss | `cat ~/.claude/MEMORY/STATE/current-work.json` — can you reconstruct current work state from this file alone? |
| Pattern synthesis runs | `ls ~/.claude/MEMORY/LEARNING/SYNTHESIS/` — check for weekly reports |

### Falsifiability Principle Verification

| What implementation makes it real | How to verify |
|----------------------------------|--------------|
| ISC criteria written BEFORE execution | Check PRD timestamps — `started` field in frontmatter should precede any code changes |
| Criteria are atomic (not compound) | Audit any PRD: do all criteria pass the Splitting Test? (no "and", no "all", no scope words without enumeration) |
| VERIFY phase always runs | Check Algorithm sessions in MEMORY/WORK — do all have `phase: complete` (not `phase: execute`)? |
| Performance signals captured | `tail ~/.claude/MEMORY/LEARNING/SIGNALS/ratings.jsonl` — regular entries? |

### Alignment Principle Verification

| What implementation makes it real | How to verify |
|----------------------------------|--------------|
| AISTEERINGRULES.md loaded at session start | Check SessionStart hook output — steering rules should appear in loaded context |
| Anti-criteria present in PRDs | Audit PRDs — do they include `ISC-A` (anti-criteria) for significant tasks? |
| Slack messages route to DM only | Grep all devops scripts: `grep -r "general" windmill/f/devops/` — should find zero active fallbacks |
| Approval flows gate destructive ops | Check `approval_flow.ts` and `approve_remediation.ts` are referenced in pipeline |

---

## Part XI: Current Gaps (Principles Not Yet Fully Implemented)

Honest accounting of where the architecture is principled in design but not yet fully implemented:

| Gap | Principle Violated | Status |
|-----|-------------------|--------|
| Triage feedback loop (outcome→quality improvement) — `triage_feedback.ts` + `trend_engine.ts` exist but loop is partial | Persistence + Alignment | Phase 3 — spec in [Roadmap](./specs/implementation-roadmap) |
| Entity extraction not automated (manual correlation) — must be designed with feedback loop | Bandwidth Principle | Phase 3 — spec in [Roadmap](./specs/implementation-roadmap) |
| Contextual surfacing into active workstreams — `contextual_surface.ts` exists but partial; requires entity + feedback first | Bandwidth Principle | Phase 3 — blocked by entity extraction |
| Time-series trend storage — `trend_engine.ts` exists and handles this; partial implementation in progress | Persistence Principle | Phase 3 (completing trend_engine) |
| .claude volumes were `:rw` for Windmill workers | Falsifiability (immune system) | **Fixed 2026-03-30** |
| PAI sessions not yet containerized | Scaffolding > Model | **Specced — [Docker-Modular](./specs/docker-modular) Phase 1** |
| Ansible still 16 roles (host-coupled) | Scaffolding > Model | **Specced — [Docker-Modular](./specs/docker-modular) Phase 1** |
| MEMORY merge strategy for concurrent sessions | Persistence Principle | **Specced — [Docker-Modular](./specs/docker-modular) Phase 2** |
| Platform is domain-specific (DevOps only) | Bandwidth Principle (limits who benefits) | **Specced — [Modularization](./specs/modularization)** |

---

## Part XII: Anti-Patterns — What Violates the Principles

These are specific behaviors that violate bedrock principles. The principle is not a preference when violated — the cognitive architecture genuinely degrades.

| Anti-Pattern | Principle Violated | Effect |
|-------------|-------------------|--------|
| "Just do this quickly without ISC" | Falsifiability | Output cannot be verified; hallucination risk undetected |
| Completing work without MEMORY write | Persistence | Context permanently lost at session end |
| Using shell commands when MCP tool exists | Scaffolding > Model | Reduced auditability, less deterministic |
| Broadcasting alerts to `#general` | Bandwidth | Seth's attention wasted on non-directed signal |
| Mounting `.claude:rw` in Windmill workers | Alignment (immune system) | Prompt injection can modify PAI's reasoning substrate |
| Mounting Docker socket in PAI container | Alignment (immune system) | Prompt injection → container escape → host compromise |
| Writing ISC criteria after seeing the output | Falsifiability | Post-hoc rationalization; ISC becomes documentation, not hypothesis |
| Skipping VERIFY phase | Falsifiability | "Done" without verification is assertion, not result |
| Running destructive ops without approval flow | Alignment | AI acts without human gate on irreversible changes |
| Single-session work without agent delegation | Bandwidth | Seth's 10 bits/sec becomes the bottleneck for parallelizable work |

---

## Part XIII: Operational Principles — The Steering Rules Layer

The 16 founding principles explain *why* PAI+imladris is designed as it is. A second tier — the `AISTEERINGRULES.md` — enforces *how* the AI must operate within that design. These are not separate philosophy; they are each a direct enforcement mechanism for one of the 4 bedrock principles, loaded at every session start.

| Operational Rule | Bedrock Principle | Why This Rule Exists |
|-----------------|-------------------|----------------------|
| **Surgical fixes only** — never add or remove components as a fix | Falsifiability | Minimal diffs produce falsifiable results; large rewrites obscure what changed |
| **Never assert without verification** — show evidence, not claims | Falsifiability | A claim without evidence is not falsifiable — it's noise in the feedback loop |
| **First principles over bolt-ons** — understand → simplify → reduce → add | Falsifiability | Bolt-ons mask root causes and prevent true hypothesis testing |
| **Build ISC from every request** — decompose to verifiable criteria first | Falsifiability | ISC is Principle #15 (Science as Cognitive Loop) instantiated per task |
| **One change when debugging** — isolate, verify, proceed | Falsifiability | Changing multiple variables simultaneously destroys experimental validity |
| **Error recovery** — review, identify violation, fix, capture learning | Falsifiability | Errors are data; the learning loop requires honest post-mortems |
| **Ask before destructive actions** — force push, rm -rf, prod deploy | Alignment | Irreversible actions bypass the human gate required by Principle #8 |
| **Plan means stop** — present plan, wait for approval | Alignment | Execution without consent violates the principal-agent boundary |
| **AskUserQuestion for choices** — structured options, not prose | Alignment | Human decision authority requires clear option surfaces, not buried prose |
| **Don't modify user content without asking** | Alignment | Seth's words are Seth's; AI does not overwrite the principal's authored content |
| **Check git remote before push** | Alignment | Verifying intent before irreversible shared-state action |
| **Minimal scope** — only change what was asked | Bandwidth | Unrequested changes consume Seth's 10 bits/sec review capacity on things not requested |
| **Read before modifying** | Persistence | Observe current state before changing it; no blind writes |
| **PAI Inference Tool for AI calls** | Persistence | Consistent tracing and logging of all AI calls through a single instrumented path |

### The Two-Tier Principle Architecture

```
TIER 1: Founding Principles (PAISYSTEMARCHITECTURE.md)
  WHY the system exists and is designed this way
  → 16 principles grounded in cognitive science
  → Permanent, rarely change

TIER 2: Operational Rules (AISTEERINGRULES.md)
  HOW the AI must behave within the design
  → Enforcement mechanisms for the 4 bedrock principles
  → Force-loaded at every session start via settings.json
  → Can be updated as failure patterns are observed
```

The operational rules are the system learning from its own failure patterns. When a rule exists in `AISTEERINGRULES.md`, there is a past incident that motivated it. The rules are not arbitrary constraints — they are crystallized learning, exactly what the NEXTUP/dream-consolidation analogy predicts: high-salience failures (unexpected errors, wrong assertions, scope creep) consolidate into persistent behavioral modification.

---

## What This Document Is and Isn't

**This document is:**
- The cognitive science rationale for why PAI+imladris is designed as it is
- A map from bedrock principles → derived principles → implementation
- A verification matrix for auditing whether principles are being followed
- A guide for evaluating whether a proposed change is principled

**This document is not:**
- A catalog of scripts and what they do (→ [DevOps Automation](./windmill/devops) and [Investigation Tools](./windmill/investigate))
- A list of architecture decisions (→ [Architecture Decisions](./architecture))
- A deployment guide (→ [Ansible](./ansible/) and [CloudFormation](./cloudformation/))
- An algorithm reference (→ `~/.claude/PAI/Algorithm/v3.5.0.md`)

---

## Docs Site Map

| What you want to know | Where to look |
|----------------------|--------------|
| Why everything is designed this way | **This document** |
| What each script does | [DevOps Automation](./windmill/devops) / [Investigation Tools](./windmill/investigate) |
| Which 37 architecture decisions govern imladris | [Architecture Decisions](./architecture) |
| What Ansible roles configure | [Ansible](./ansible/) |
| What CloudFormation templates deploy | [CloudFormation](./cloudformation/) |
| What PAI config (skills, hooks) is deployed | [PAI Configuration](./pai-config) |
| The Docker-modular redesign plan | [Docker-Modular Architecture](./specs/docker-modular) |

---

*Document generated by PAI Algorithm + FirstPrinciples + Research, 2026-03-30.*
*Sources: Zheng & Meister (Neuron, 2024); Clark & Chalmers (Analysis, 1998); Friston (Nature Reviews Neuroscience, 2010); PAI PAISYSTEMARCHITECTURE.md; imladris ARCHITECTURE.md (37 decisions).*
