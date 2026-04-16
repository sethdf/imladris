# Standard Research Workflow

**Mode:** 2 different researcher types, 1 query each | **Timeout:** 1 minute

## 🚨 CRITICAL: URL Verification Required

**BEFORE delivering any research results with URLs:**
1. Verify EVERY URL using WebFetch or curl
2. Confirm the content matches what you're citing
3. NEVER include unverified URLs - research agents HALLUCINATE URLs
4. A single broken link is a CATASTROPHIC FAILURE

See `SKILL.md` for full URL Verification Protocol.

## When to Use

- Default mode for most research requests
- User says "do research" or "research this"
- Need multiple perspectives quickly

## Workflow

### Step 1: Craft One Query Per Researcher

Create ONE focused query optimized for each researcher's strengths:
- **Claude**: Academic depth, detailed analysis, scholarly sources
- **Gemini**: Multi-perspective synthesis, cross-domain connections

### Step 2: Launch 2 Agents in Parallel (1 of each type)

**SINGLE message with 2 Task calls:**

```typescript
Task({
  subagent_type: "ClaudeResearcher",
  description: "[topic] analysis",
  prompt: "Do ONE search for: [query optimized for depth/analysis]. Return findings immediately."
})

Task({
  subagent_type: "GeminiResearcher",
  description: "[topic] perspectives",
  prompt: "Do ONE search for: [query optimized for breadth/perspectives]. Return findings immediately."
})
```

**Each agent:**
- Gets ONE query
- Does ONE search
- Returns immediately

### Step 3: Quick Synthesis

Combine the two perspectives:
- Note where they agree (high confidence)
- Note unique contributions from each
- Flag any conflicts

### Step 4: VERIFY ALL URLs (MANDATORY)

**Before delivering results, verify EVERY URL:**

```bash
# For each URL returned by agents:
curl -s -o /dev/null -w "%{http_code}" -L "URL"
# Must return 200

# Then verify content:
WebFetch(url, "Confirm article exists and summarize main point")
# Must return actual content, not error
```

**If URL fails verification:**
- Remove it from results
- Find alternative source via WebSearch
- Verify the replacement URL
- NEVER include unverified URLs

### Step 5: Return Results

```markdown
📋 SUMMARY: Research on [topic]
🔍 ANALYSIS: [Key findings from 2 perspectives]
⚡ ACTIONS: 2 researchers × 1 query each
✅ RESULTS: [Synthesized answer]
📊 STATUS: Standard mode - 2 agents, 1 query each
📁 CAPTURE: [Key facts]
➡️ NEXT: [Suggest extensive if more depth needed]
📖 STORY EXPLANATION: [5-8 numbered points]
🎯 COMPLETED: Research on [topic] complete
```

## Auto-Persist Results

**Save findings to disk before returning** — protects against session-end and context compaction.

1. Generate a `SLUG` from the topic: lowercase, replace spaces with hyphens, strip special chars, ≤30 chars
2. Use the **Write tool** to create:
   `~/.claude/History/research/YYYY-MM/YYYY-MM-DD_[SLUG]/output.md`
   with the full formatted results from Step 5
3. If a work item is active, also copy there:
   ```bash
   WORK_DIR=$(jq -r '.work_dir // empty' ~/.claude/MEMORY/STATE/current-work.json 2>/dev/null)
   # If $WORK_DIR is non-empty:
   # cp History output → ~/.claude/MEMORY/WORK/$WORK_DIR/research-$(date +%H%M%S).md
   ```
4. **Failures are non-fatal** — if Write fails, continue and return results to user normally

## Speed Target

~15-30 seconds for results
