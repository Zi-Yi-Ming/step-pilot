# Benchmark

> The goal is not a world-class benchmark. It is to let a developer answer one question:
> **What actually changes in model behavior once the harness is added?**

## Purpose

Step Pilot is both a product and an agent-harness experiment. The benchmark is its measurement side: run a fixed set of local tasks, record process metrics, and make harness changes observable rather than a matter of impression.

**Product runtime and research measurement share one truth** — the benchmark consumes the same structured events as `wire.jsonl`.

## Quick start

```bash
pnpm benchmark list                                    # list tasks
pnpm benchmark run --task single-file-bug-001 --runs 1  # run one task
pnpm benchmark run --runs 3                             # run all tasks 3× each
pnpm benchmark dashboard --dir benchmark/results        # aggregate dashboard
pnpm benchmark dashboard --badge                        # print a shields.io badge URL
```

| Flag | Meaning |
|------|---------|
| `--task <id>` | Run only the given task |
| `--profile <name>` | Profile to use (default `full`) |
| `--runs <n>` | Runs per task (default 3) |
| `--output <path>` | Result JSON output path |
| `--dir` / `--out` / `--badge` | Dashboard-only options |

You need a configured provider and API key (see [Quick start](./quickstart.md)). **All tasks run locally and need no internet.**

## Built-in tasks

| Task | Category | Difficulty | Description |
|------|----------|------------|-------------|
| `single-file-bug-001` | single-file bug fix | easy | Fix the off-by-one in `src/utils.ts` |
| `multi-file-bug-001` | API contract mismatch | medium | `renderProfile()` uses `data.name` but should use `data.fullName` |
| `long-horizon-001` | long-horizon debugging | hard | `discountTotal()` returns a negative value when the discount exceeds the total; the test expects 0 |
| `cascading-fix-001` | cascading fix (recovery) | hard | 3 independent bugs across 3 files; each test run reveals the next |
| `feature-spec-001` | feature implementation | hard | Implement a task-management API to spec (validation / permissions / cache / audit / CSV export) |

Each task is described by a `task.yaml` (`repository` / `setup` / `verify` / `success_criteria`). The setup script rebuilds the repo into a temporary copy, so tasks are **repeatable**.

## Recorded metrics

Per run (`results[]` in `benchmark/results/*.json`):

`success` / `duration_ms` / `turns` / `tool_calls` / `tool_errors` / `retries` / `compactions` / `stop_reason` / `failure_reason` / `checks_passed` / `checks_failed` / `harness_error` / `verification_skipped`, plus the full `events` array (enough to reconstruct a tool-by-tool trace).

Dashboard aggregates (`pnpm benchmark dashboard`):

- Success rate
- Average tokens
- **Empty-response rate** — thinking consumed the whole `max_tokens` budget and the model produced nothing
- **Tool-leak rate** — the model wrote a tool call as plain text, so the tool never executed
- Harness-failure rate (`harness_broken`) and verification-skip rate (`verification_skipped`)

The last two are this project's most characteristic "silent failures"; before the dashboard existed, nothing aggregated them.

## Where the classifiers stop (important)

- **Empty response** is not judged by "output tokens < N": legitimately short answers ("1+1 is 2") produce almost no output, and separating those requires task-complexity information the client does not have.
- **Tool leak** matches the angle-bracket tag form only, never bare words: bare words appear literally in this repo's own docs, so an agent repeating them would false-positive.
- **Harness failure is not model failure**: `harness_error` means the execution environment broke (missing test files, module resolution failure, command not found) and must **not** be counted as model capability.

## ⚠️ Historical results are not citable

Numbers under `benchmark/results/` include samples from the **defective-framework period**. The canonical case is D1: `runner.ts` implemented "make the test file read-only" as `rmSync(file, { mode: 0o444 })` — but `rmSync` has no `mode` option, so the call was silently **deleting** the test file. Verify's `npx vitest run` then failed permanently with `No test files found` — **correct fixes scored as failures**.

Before that fix, the dashboard recorded those samples as "model success rate".

> **Conclusion: success-rate figures from before the D1 fix and its re-run are not citable.** Any public capability claim must come from a fresh run after the fix.

All six framework defects (symptom / root cause / evidence / fix) are documented in [`benchmark/HARNESS-AUDIT.md`](../../benchmark/HARNESS-AUDIT.md).

## Nightly collection

`.github/workflows/reliability.yml` runs on a schedule and manually, executing the benchmark and dashboard and keeping artifacts. Two deliberate guards:

- **Skips entirely without an API key instead of failing** — every fork has this workflow but not the upstream secret; without the guard it would go red daily on every fork.
- Aggregates only the **current** run rather than mixing generations across the whole `results/` directory.

## About token counts

Step's three protocols always report `reasoning_tokens: 0` and thinking consumption is not observable; in practice the provider-reported `input / output / total` figures can contradict each other.

So: **the dashboard may show tokens, but public capability narratives should not depend on them**, and they should not be used to estimate cost. When no reliable number exists, this project publishes nothing rather than inventing one.
