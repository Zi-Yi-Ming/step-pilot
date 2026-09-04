# Step 3.7 Flash Best Practices

step-pilot applies multiple optimizations for Step 3.7 Flash, but the model's characteristics mean it shouldn't be used like a large model. This page explains why these design choices exist and how you can work with Flash effectively.

## Why Flash needs special treatment

Step 3.7 Flash is a sparse MoE architecture (198B total parameters / 11B active parameters). It's fast and cheap to run, but it degrades noticeably when:

- **Context gets too long**: Once system prompt + tool results + history exceeds a certain length, instruction following quality drops
- **Tool contracts are vague**: Verbose or ambiguous tool descriptions make small models guess wrong
- **Single tool outputs are huge**: A 5000-line bash output drowns out all subsequent instructions
- **Compaction is lazy**: Waiting until context is almost full before compacting means the model has already "forgotten" the original task

step-pilot's design philosophy is not "make Flash behave like a 700B model", but "don't waste its context on things that don't matter."

## What step-pilot does differently

### 1. Trimmed system prompt

The system prompt is compressed from ~3500 to ~2000 characters, keeping only:

- Identity and working environment
- Core behavioral rules
- Tool usage discipline
- Context budget awareness

Removed sections include: redundant self-description, model training cutoff reminders (replaced with live search), and optional tool suggestions.

### 2. Tightened tool result cap

The tool result ceiling is capped at 400K characters. For small models especially: shorter context means more stable instruction following.

### 3. Earlier compaction trigger

Default compaction trigger ratio is 75%. During summarization, the last 6 messages are retained, and the user message fidelity budget is 20K tokens. Compaction fires earlier and more aggressively, preventing tool results from blowing up the context.

### 4. Semantic tool-result preprocessing

Long outputs from `bash` and `read_file` get structure-preserving truncation:

- `bash`: keeps first 50 lines + last 20 lines, omits the middle
- `read_file`: keeps first 10 paragraphs + last 5 paragraphs, omits the middle

The model gets the key context without being drowned in noise.

### 5. Rewritten core tool descriptions

Five core tools (`bash`, `spawn_agent`, `edit_file`, `ask_user`, `skill`) have their descriptions rewritten for unambiguous instruction following on Flash.

## How you can help

### Be specific with task descriptions

Small models aren't as good at "guessing intent" as large models. Instead of "help me look at this project", try:

> Read `src/agent/loop.ts`, find the `maybeCompact` function, and explain why it scales down `usedTokens` by the ratio after micro compaction.

### Break complex tasks into steps

Flash handles "single-turn clear instructions" better than "open-ended exploration". For multi-file or multi-stage tasks, consider:

1. Use `spawn_agent` for read-only investigation first
2. Synthesize the findings yourself
3. Then make changes

### Control tool output scope

- `bash`: add `head`/`tail`/`grep` to narrow output
- `read_file`: use `offset`/`limit` to read sections, don't dump 10000 lines at once
- `glob`/`grep`: give concrete paths and filename patterns, don't search all of `src/`

### Use `/compact` proactively

If the model starts "forgetting" or repeating itself, trigger `/compact` manually. Earlier compaction means less information loss.

### Choose thinking levels wisely

- **Low-difficulty tasks** (single-file edits, simple Q&A): use `low` or `off` to save cost and time
- **Medium difficulty** (multi-file changes, reasoning needed): use `medium`
- **High difficulty** (complex architecture, multi-step debugging): use `high`

Flash's `high` thinking level is much lower than a large model's `high`—don't expect it to "think for very long".

## Known limitations

- **Tool call format errors**: Flash occasionally generates invalid tool calls (missing fields, wrong types). Currently rejected outright; a more lenient correction-and-retry may be added in the future
- **Long reasoning chains**: Beyond ~10 turns on complex tasks, Flash's instruction following degrades noticeably—break work into smaller subtasks
- **Context window**: While 256K is supported, the stable working range is around 100K tokens; quality degrades significantly beyond that

## Design decisions

These are the key trade-offs behind step-pilot's Step 3.7 Flash optimizations, documented so future maintainers understand why things are built this way.

### Why the system prompt is ~2000 characters

Small models have limited attention budget. Every instruction in the system prompt competes with user messages and tool results for position. We cut from ~3500 to ~2000 characters by removing:

- Redundant self-description ("I am Step Pilot, a TUI Agent running in your terminal")
- Model training cutoff reminders (replaced with live search)
- Optional tool suggestions ("use web_image_search when you need illustrations")

What stays: identity, working environment, core behavioral rules, tool usage discipline, context budget awareness.

What we intentionally kept unchanged: permission system, plan mode, sub-agent delegation rules — these are safety boundaries that don't change with model size.

### Why the tool result cap is 400K

Uncapped tool results can flood the context window. 400K is the current ceiling, aligned with `web_fetch`'s per-call limit. For small models especially: shorter context means more stable instruction following.

### Why compaction is more aggressive

Default trigger ratio is 75%. Retained messages are the last 6 during summarization. User message fidelity budget is 20K tokens.

Reason: Flash's context quality degrades more steeply than large models. At 85% utilization, the model has already "forgotten" many early instructions. The 75% trigger + aggressive retention strategy is the sweet spot for Flash between "compaction quality" and "context freshness."

### Why tool-call tolerance is intentionally shallow

The current implementation handles only the two most common small-model format errors:
- String `"true"/"false"` → boolean
- Numeric strings → numbers

We intentionally did NOT add more aggressive tolerance (like guessing defaults for missing fields, or force-converting mismatched types), because:

1. Small-model format errors are usually at the "type level", not "semantic level"
2. Semantic guessing (e.g., inferring which file the user wants when `path` is missing) is too risky — it can cause unwanted side effects
3. Shallow tolerance already covers ~80% of common errors; investing in higher-risk behavior isn't worth it

## References

- [Step 3.7 Flash official docs](https://platform.stepfun.com/docs/guides/model#step-3.7-flash)
- step-pilot source code: `src/agent/systemPrompt.ts`, `src/agent/toolResultLimit.ts`, `src/agent/compaction/compact.ts`
