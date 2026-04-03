# DomainSpecific Workflow

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the DomainSpecific workflow in the BeCreative skill to apply domain creativity"}' \
  > /dev/null 2>&1 &
```

Running **DomainSpecific** in **BeCreative**...

---

**When to use:** Creativity within specific domains (artistic, business, technical)

---

## Artistic Creativity Template

```markdown
## Instructions

DEEP THINKING - ARTISTIC CREATIVITY

Think deeply about this artistic challenge:
- Explore bold and experimental approaches
- Question conventional aesthetic assumptions
- Make unexpected connections across art forms
- Consider emotional impact and audience experience
- Push boundaries while maintaining coherence

Generate artistically bold and innovative responses.

## Challenge

[Artistic challenge]
```

**Best for:** Visual arts, music, writing, performance, design

---

## Business Innovation Template

```markdown
## Instructions

DEEP THINKING - BUSINESS INNOVATION

Think deeply about this business challenge:
- Question conventional business model assumptions
- Explore approaches from other industries
- Consider customer psychology and behavior
- Evaluate scalability and sustainability
- Balance innovation with practical implementation

Generate innovative business solutions that challenge conventional thinking.

## Challenge

[Business challenge]
```

**Best for:** Strategy, marketing, product, operations, growth

---

## Process

1. **Identify domain** - artistic, business, or other
2. **Select appropriate template** for the domain
3. **Apply domain-specific thinking prompts**
4. **Generate options** that challenge domain conventions
5. **Evaluate against domain criteria** (e.g., scalability for business, emotional impact for art)
6. **Output refined solution** appropriate for the domain


---

## Auto-Persist Results

**Save output to disk before returning** — extended thinking is expensive to reproduce.

1. Generate a `SLUG` from the topic/request: lowercase, hyphens, ≤30 chars
2. Use the **Write tool** to create:
   `~/.claude/History/thinking/YYYY-MM/YYYY-MM-DD_[SLUG]/output.md`
   with the full creative output
3. If a work item is active, also copy there:
   ```bash
   WORK_DIR=$(jq -r '.work_dir // empty' ~/.claude/MEMORY/STATE/current-work.json 2>/dev/null)
   # If $WORK_DIR is non-empty:
   # cp History output → ~/.claude/MEMORY/WORK/$WORK_DIR/creative-$(date +%H%M%S).md
   ```
4. **Failures are non-fatal** — if Write fails, continue and return results normally
