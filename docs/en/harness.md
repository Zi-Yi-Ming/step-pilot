# Harness

> Step Pilot's differentiator is not "which model it calls" but the **harness deliberately engineered around the model**. This page covers its five parts: context management, retry, recovery, verification, and traces.

## Why a harness at all

Lightweight models (Step 3.7 Flash, for example) are fast and cheap, but they break under traditional agent scaffolding: long system prompts, runaway tool output, and lazy compaction eat the context window before the real work starts.

Step Pilot's question is:

> **How far can a lightweight model go with the right harness?**

So everything below is an **engineering constraint**, not decoration.

---

## 1. Context Management

Context is a budget, not a log.

| Mechanism | Default behavior |
|-----------|------------------|
| System prompt | ~2000 chars — the smallest useful instruction set, not an encyclopedia |
| Tool result cap | 400K chars per result, so one runaway command cannot drown the model |
| Result preprocessing | `toolResultPreprocess` normalizes grep / glob / web_fetch output before feeding it back |
| Compaction trigger | Fires at 75% context occupancy |
| Compaction policy | Full summarization keeps the last 6 messages; user messages get a 20K token fidelity budget |
| Micro-compaction | Lightweight reclamation first, deferring full summarization when possible |

**Why not "just append everything"**: unbounded tool output leaves the model no window left when it actually needs to reason. Better to drop old detail than let context grow without bound.

> Token estimates are heuristic when the provider exposes no reliable tokenizer. Documentation and output mark them approximate rather than pretending to be exact.

---

## 2. Retry

Retry lives in the provider layer (`src/provider/retry.ts`) and applies **only to clearly retryable failures**:

- `EmptyResponseError` — empty response
- `StreamIdleTimeoutError` — stream idle timeout
- `MaxTokensExhaustedError` — output truncated by `max_tokens`

Exponential backoff plus a retryability check. **Non-retryable errors (invalid arguments, for example) are not retried** — retrying the unrecoverable only stretches the failure and floods the context with noise.

---

## 3. Recovery

Recovery is "what to do next after a failure", not "run the same prompt again".

Built into the agent loop (`src/agent/loop.ts`):

- **`maxIterations`** (default 500) — hard ceiling against infinite loops
- **Staged turn warnings** — at mid and late thresholds the model is told "turn N of M" so it has a chance to converge
- **`noProgress` detection** — identifies "still calling tools but not advancing" and stops
- **Parallel tool scheduling** — conflict detection, out-of-order execution, ordered collection

When a tool fails, the model receives **structured error feedback** (tool name, arguments, failure reason) and decides: retry / change arguments / switch tool / stop.

---

## 4. Verification

**A model saying "Done." is not accepted.**

Two paths:

1. **`postGreen` (`src/agent/postGreen.ts`)** — when a full green test suite appears in a batch of tool results, the run can terminate early. Off by default (opt-in) because it is an experimental intervention.
2. **Mission verifier (`step mission verify`)** — an independent control plane: runs the `acceptance` commands recorded in the manifest, compares exit codes, writes an evidence bundle. `completed` can **only** be reached through `verification.completed(passed=true)`; the model claiming completion does not count.

Key invariant — **harness failure is not assertion failure**:

When a command exits nonzero and its output matches environment-failure signatures (`No test files found`, `Cannot find module`, `command not found`…), it is classified as "the environment broke" rather than "the assertion did not pass". The Mission rolls back to `running` and is explicitly marked — it is **never** set to `completed` or `failed` on that basis.

Otherwise a framework bug reads as "the model got it wrong" — exactly the lesson of defect D1 in this project's benchmark audit.

---

## 5. Traces

Every run emits structured events:

- **Session fact source**: `~/.step-pilot/.../<session>.wire.jsonl`, append-only; events are the truth
- **Mission fact source**: Mission events live separately under `missions/<repo bucket>/<missionId>.events.jsonl` and are **not** written into the session wire (different lifecycles; mixing them corrupts session resume)

Events cover `thinking_start/end`, `tool_start` / `tool_end` (with `isError` and duration), `usage`, `text`, `turn_done`, and `result`.

Non-interactive mode can emit `stream-json` directly for CI and external analysis. The benchmark harness reuses the same events to produce its result JSON, so **product runtime and research measurement share one truth**.

---

## One real run (not a mock-up)

Task `cascading-fix-001`: three independent bugs are planted in a repo, and each test run reveals the next one.

Model **step-3.7-flash**, provider **stepfun**, executed 2026-09-18:

```
list_dir ×2  →  read_file ×5
[8]  edit_file                     fix JSON parser
[9]  bash  npx vitest run          x  ✓ parses json | × filters active | × formats output   (1/3)
[10] edit_file                     fix active filter
[11] bash  npx vitest run          x  ✓ parses | ✓ filters active | × formats output        (2/3)
[12] edit_file                     fix HTML formatter
[13] bash  npx vitest run          ✓  src/cascade.test.ts (3 tests)  Tests 3 passed (3)     (3/3)
```

| Metric | Measured |
|--------|----------|
| Outcome | success (verification 1 passed / 0 failed) |
| Turns | 10 |
| Tool calls | 13 |
| Tool errors (recovered) | 2 |
| Retries | 0 |
| Compactions | 0 |
| Duration | 42.2s |

**Note**: no token count is listed here. Step's three protocols always report `reasoning_tokens: 0` and thinking consumption is not observable; the `input / output / total` figures reported for this run contradict each other. Per this project's discipline, when no reliable number exists it is **not published** — no estimates filling the gap.

Raw result: `benchmark/results/demo-cascading-fix.json`.

---

## Honesty boundaries (apply throughout)

1. **Historical benchmark results are not citable**: numbers under `benchmark/results/` include samples from the defective-framework period (D1: a deleted test file made verify fail permanently), so they are **not model capability**. Any public capability number must come from a fresh run.
2. **No invented token or latency figures**: only fields the provider reliably returns are published.
3. **No overclaiming**: no "fixed N upstream bugs", no coverage percentages, no cost-saving narrative. Every mechanism described here maps to a module that actually exists in `src/`.
