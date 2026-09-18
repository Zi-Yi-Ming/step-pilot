# Architecture

> This page describes module boundaries and data flow. Read it before changing code; new capability belongs in an existing layer, not in a new parallel one.

## In one line

Step Pilot is a terminal coding agent: the model calls tools to read and write real files and run real commands, results flow back into the loop, and it continues until the task is done or explicitly stopped. The focus is not "calling a model" but the **harness deliberately engineered around it** — context engineering, tool contracts, failure recovery, verification, and observability.

## Layers

```
                        ┌─────────────┐
   user input ─────────▶│   cli.ts    │  args, subcommands, non-interactive mode
                        └──────┬──────┘
                               │
                        ┌──────▼──────┐
                        │   tui-pi    │  pi-tui render layer (presentation only)
                        │  + chat/    │  stream buffer, diff, commands, input
                        └──────┬──────┘
                               │ event stream
   ┌───────────────────────────▼────────────────────────────┐
   │                    agent (the harness core)             │
   │  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
   │  │  loop   │ │  turns   │ │ scheduler│ │ permission │  │
   │  │iterate  │ │ turn     │ │ parallel │ │  tiering   │  │
   │  └────┬────┘ └──────────┘ └──────────┘ └───────────┘  │
   │       │                                                │
   │  ┌────▼──────────┐  ┌────────────┐  ┌───────────────┐ │
   │  │  compaction   │  │ toolResult │  │ wire / wirelog │ │
   │  │ context trim  │  │ result cap │  │ structured evts│ │
   │  └───────────────┘  └────────────┘  └───────────────┘ │
   └───────┬──────────────────────────┬────────────────────┘
           │                          │
    ┌──────▼───────┐          ┌───────▼────────┐
    │    tools     │          │    session     │
    │ registry/exec│          │ persistence    │
    └──────┬───────┘          └────────────────┘
           │
    ┌──────▼───────┐
    │   provider   │  multi-protocol, retry, capability degradation
    └──────┬───────┘
           │
    ┌──────▼───────┐
    │    config    │  TOML / env vars / model aliases
    └──────────────┘
```

`main.ts` is only the bin bootstrap: it sets `NODE_ENV`, then loads `cli.js`.

## Layer responsibilities

### config (`src/config/`)

Reads `~/.step-pilot/config.toml`, `.env` and environment variables; resolves provider presets and model aliases into one stable runtime config. **This layer knows nothing about agent semantics.**

### provider (`src/provider/`)

Unifies four protocols (Step/Anthropic Messages, OpenAI Chat Completions, OpenAI Responses) into one event stream:

- `factory.ts` dispatches assembly by channel `type`
- `step/` handles Step-specific semantics (the three protocols name and nest the thinking parameter differently; `stepCommon.ts` translates)
- `retry.ts` exponential backoff plus retryability, modelling "empty response", "stream idle timeout" and "max_tokens exhausted" as `EmptyResponseError` / `StreamIdleTimeoutError` / `MaxTokensExhaustedError`
- `capability-registry.ts` + `degrader.ts` degrade proactively per model capability (media blocks to placeholders, thinking stripped, cache_control stripped)

**Boundary**: provider sends the request and turns the response into events. It never decides whether the task is complete.

### tools (`src/tools/`)

36 modules registered through `index.ts`. Each tool is `name + description + input_schema + execute()` and is gated by the permission layer.

- Filesystem: `readFile` / `write` / `edit` / `listDir` / `glob` / `grep` (grep carries ReDoS guards)
- Execution: `bash` (cross-platform `shellResolve`: Git Bash → WSL → busybox → PowerShell on Windows; never falls back to cmd.exe)
- Others: `task` / `todoList` / `webFetch` / `webSearch` / `skill` / `spawnAgent` / `team` / `dynamicWorkflow`

**Boundary**: a tool does not judge whether the task is finished; it returns a structured result.

### agent (`src/agent/`) — the harness core

| Module | Responsibility |
|--------|----------------|
| `loop.ts` | Iteration control: `maxIterations` (default 500), mid/late turn warnings, `noProgress` detection |
| `roundLoop.ts` / `thinkingLoop.ts` / `runTurn.ts` | Single-turn orchestration: stream → tool_use → authorize → execute → feed back |
| `turns.ts` | Turn derivation and truncation by turn |
| `toolScheduler.ts` | Parallel scheduling: conflict detection, out-of-order execution, ordered collection |
| `toolResultLimit.ts` / `toolResultPreprocess.ts` | Result cap (400K chars) and preprocessing so one command cannot drown the context |
| `compaction/compact.ts` | Micro-compaction and full summarization (default trigger at 75%, keeps the last 6 messages, 20K token fidelity budget for user messages) |
| `permission/mode.ts` | Three tiers manual / auto / yolo, plus a hard block in plan mode |
| `wire.ts` / `wirelog.ts` | Structured events (the fact source) |
| `systemPrompt.ts` / `agentsMd.ts` | ~2000-char system prompt and project-convention loading |
| `mission/` | Task control plane: fact chain, checkpoints, recovery analysis, independent verifier |

### session (`src/session/`)

`SessionStore` writes a JSON snapshot while `wire.jsonl` is **append-only** as the fact source: the snapshot is a checkpoint, the events are the truth. Supports resume / continue / fork and non-interactive `stream-json` output.

### tui-pi + chat (presentation)

`PiChat` is the composition root and consumes the agent event stream; `chat/` provides stream buffering, diff view, commands and input history. **This layer must not reach back into agent decisions.**

## Data flow for one task

```
user input
  ↓
cli parse (interactive / -p non-interactive)
  ↓
config resolves provider + model
  ↓
agent loop:
  OBSERVE  assemble context (system + task + repo + recent turns + tool results)
  REASON   request the model; stream thinking / text / tool_use
  ACT      permission check → execute tools (parallel) → structured results
  OBSERVE  trim results and feed back; compact when needed
  …repeat until the model stops calling tools
  ↓
verification (postGreen / mission verify)
  ↓
session persisted + wire events appended
  ↓
rendered by the TUI
```

## Design trade-offs

1. **Events are the fact source; snapshots are derived.** A snapshot can be rebuilt; events are only appended. Recovery, replay and benchmark then share one truth.
2. **Context is a budget, not a log.** Tool results are capped, trimmed and compacted; better to drop old detail than let context grow without bound.
3. **The provider is replaceable; the harness is not.** Switching models is configuration. Harness behavior — when to compact, where retry stops, how permission is decided — is the product.
4. **The presentation layer is replaceable.** A pi-tui frontend exists today; `-p` and `stream-json` let CI and benchmark drive the same agent without a TUI.

## Boundaries not to break

- Do not make task decisions inside `tui-pi/` or `chat/`.
- Do not let `provider/` decide task completion.
- Do not let a tool choose its own retry policy (retry lives in the agent and provider layers).
- Mission events are **not** written into the session `wire.jsonl` — the two lifecycles differ, and mixing them corrupts session resume.
