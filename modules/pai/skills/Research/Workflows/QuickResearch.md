# Quick Research Workflow

**Mode:** Single Claude researcher, 1 query | **Timeout:** 30 seconds

## When to Use

- User says "quick research" or "minor research"
- Simple, straightforward queries
- Time-sensitive requests
- Just need a fast answer

## Workflow

### Step 1: Launch Single Claude Agent

**ONE Task call - Claude researcher with a single focused query:**

```typescript
Task({
  subagent_type: "ClaudeResearcher",
  description: "[topic] quick lookup",
  prompt: "Do ONE web search for: [query]. Return the key findings immediately. Keep it brief and factual."
})
```

**Prompt requirements:**
- Single, well-crafted query
- Instruct to return immediately after first search
- No multi-query exploration

### Step 2: Return Results

Report findings using standard format:

```markdown
📋 SUMMARY: Quick research on [topic]
🔍 ANALYSIS: [Key findings from Claude]
⚡ ACTIONS: 1 Claude query
✅ RESULTS: [Answer]
📊 STATUS: Quick mode - 1 agent, 1 query
📁 CAPTURE: [Key facts]
➡️ NEXT: [Suggest standard research if more depth needed]
📖 STORY EXPLANATION: [3-5 numbered points - keep brief]
🎯 COMPLETED: Quick answer on [topic]
```

## Auto-Persist Results

**Save findings to disk before returning** — protects against session-end and context compaction.

1. Generate a `SLUG` from the topic: lowercase, replace spaces with hyphens, strip special chars, ≤30 chars
2. Use the **Write tool** to create:
   `~/.claude/History/research/YYYY-MM/YYYY-MM-DD_[SLUG]/output.md`
   with the full formatted results from Step 2
3. If a work item is active, also copy there:
   ```bash
   WORK_DIR=$(jq -r '.work_dir // empty' ~/.claude/MEMORY/STATE/current-work.json 2>/dev/null)
   # If $WORK_DIR is non-empty:
   # cp History output → ~/.claude/MEMORY/WORK/$WORK_DIR/research-$(date +%H%M%S).md
   ```
4. **Failures are non-fatal** — if Write fails, continue and return results to user normally

## Speed Target

~10-15 seconds for results
