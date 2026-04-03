# MaximumCreativity Workflow

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the MaximumCreativity workflow in the BeCreative skill to explore unconventional ideas"}' \
  > /dev/null 2>&1 &
```

Running **MaximumCreativity** in **BeCreative**...

---

**When to use:** Need maximum creative diversity and unconventional thinking

---

## Template

```markdown
## Instructions

MAXIMUM CREATIVITY - DEEP THINKING + VERBALIZED SAMPLING

In your thinking, generate 5 radically different responses with probabilities (p<0.10 each).

For each candidate:
- Explore unusual perspectives and genres
- Question EVERY assumption about format and content
- Make unexpected connections across different domains
- Consider low-probability but fascinating possibilities
- Wander into unconventional and experimental territory
- Deliberately avoid ALL typical, formulaic, or cliched approaches
- What would make this truly unique and memorable?

Then select and elaborate on the most genuinely novel approach.

## Request

[User's creative request]
```

---

## Best For

- Creative fiction writing
- Poetry with unusual metaphors
- Innovative product ideas
- Unconventional solutions
- Artistic concepts
- Absolute best creative output

---

## Process

1. **Receive creative request** from user
2. **Apply maximum creativity template**
3. **Generate 5 radically different options** in thinking blocks
4. **Push boundaries** - explore experimental territory
5. **Select most novel** approach
6. **Elaborate fully** on the chosen direction


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
