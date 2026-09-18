# Troubleshooting

> Grouped by symptom. Each entry gives "symptom → cause → fix", with the cause pointing at a real module rather than a guess.

## Install and startup

### Missing module / `Cannot find module`

**Symptom**: the SEA single-file executable reports a missing module at runtime.

**Cause**: the single-file form bundles the runtime and code together and depends on no sibling files. This error means the file was truncated during download or renaming.

**Fix**: re-download and verify integrity with the accompanying `.sha256` checksum.

### Windows SmartScreen blocks the download

**Symptom**: SmartScreen warns about the downloaded executable.

**Cause**: the artifact is not code-signed, so Windows warns about executables with low download counts.

**Fix**: verify integrity with `.sha256` first, then choose "Run anyway".

### Exits immediately / complains about the Node version

**Symptom**: an engine version error on startup.

**Cause**: Node.js **≥ 22** is required (the `glob` tool uses `node:fs.globSync`, available from Node 22).

**Fix**: upgrade Node, or use the standalone executable from Releases.

## Model access

### The command produces no output at all (empty response)

**Symptom**: the model appears to think, then returns nothing.

**Cause**: thinking consumed the entire `max_tokens` budget and the output was truncated. This is one of this project's classic "silent failures"; the dashboard's **empty-response rate** is its aggregate.

**Fix**: raise `max_tokens`, or lower the thinking level (`[thinking] default_level`). Note that Step's three protocols always report `reasoning_tokens: 0`, so thinking consumption is **not observable** — you have to judge from behavior.

### The model writes tool calls as plain text and nothing executes

**Symptom**: text like `<tool_name>` appears in the reply but the tool never runs.

**Cause**: tool leak — a common instruction-following failure in small models.

**Fix**: this is a harness problem, not a configuration one. Use `pnpm benchmark dashboard` to watch the **tool-leak rate** and see whether a change helps.

### Changing the thinking level has no effect

**Symptom**: you change thinking parameters and model behavior does not change.

**Cause**: the three Step protocols name and nest the thinking parameter differently. On the anthropic channel you must use `output_config.effort` — not a top-level `effort`, and not `thinking.budget_tokens`; both of the latter are silently ignored. See [Configuration](./configuration.md) and `src/provider/step/stepCommon.ts`.

## Shell and command execution

### Every bash command fails on Windows

**Symptom**: the `bash` tool reports no usable shell.

**Cause**: the probe chain is "bash on PATH (excluding the WSL launcher) → Git Bash inferred from git → registry lookup → WSL → busybox → PowerShell", and it **does not fall back to cmd.exe** (cmd does not understand Unix syntax, so falling back to it is "runs but wrong everywhere").

**Fix**: install Git for Windows to get Git Bash. You can also set `STEP_SHELL_PATH` to an explicit interpreter path.

### A stray empty file named `nul` appears in the repo

**Symptom**: a 0-byte `nul` at the repo root.

**Cause**: on Windows, a `> nul` redirect was interpreted as a filename.

**Fix**: `nul` is a reserved Windows device name and cannot be removed with a normal `rm`. It is already in `.gitignore`; in code use `> /dev/null` instead.

## Permissions

### Writes or commands are blocked

**Symptom**: the operation does not run and asks for confirmation.

**Cause**: three tiers — `manual` (strictest by default), `auto` (writes allowed, bash still asks), `yolo` (everything allowed). Plan mode hard-blocks every write and execution tool.

**Fix**: start with `-y/--yolo` or `--auto`, or adjust the permission mode in config. **Do not treat the safety mechanism as an obstacle to route around** — high-risk commands (`rm`, `git reset --hard`, `curl | sh`, …) asking for confirmation by default is intentional.

## Context

### Late in a long task the model "forgets" earlier constraints

**Symptom**: after a long conversation the model starts ignoring earlier constraints.

**Cause**: compaction has already happened (default trigger at 75%), and old content was replaced by a summary.

**Fix**: this is expected behavior, not a defect. Adjust the compaction threshold, or put critical constraints in `AGENTS.md` (which is loaded). Watch compaction counts via `pnpm benchmark dashboard`.

### grep rejects the pattern

**Symptom**: the grep tool refuses to run and suggests a rewrite.

**Cause**: two ReDoS guards — patterns over 500 chars, or patterns matching the "quantifier inside a group + quantifier outside it" shape, are blocked. It is a shape heuristic, not a general ReDoS solution.

**Fix**: narrow the pattern as suggested, or call `rg` through `bash`.

## Sessions and traces

### State looks wrong after resuming

**Symptom**: the context after resume does not match expectations.

**Cause**: the snapshot is a checkpoint and `wire.jsonl` is the fact source; if the log has corrupt lines or sequence gaps, recovery skips them and counts them.

**Fix**: check `step mission status` or session status for `warning:` lines (corrupt lines, illegal transitions and sequence gaps are all surfaced explicitly rather than swallowed).

### Mission and session events appear mixed up

**Symptom**: you cannot find a certain class of events.

**Cause**: the two fact sources are **deliberately separate** — sessions use `wire.jsonl`, Missions use `~/.step-pilot/missions/<repo bucket>/<missionId>.events.jsonl`. Mixing them would corrupt session resume.

## Benchmark

### Success rate is unstable, or verify always fails

**Cause**: check whether it is a framework failure first. `harness_error` means the execution environment broke (missing test files, module resolution failure, command not found) — **not** that the model got it wrong.

**Fix**: inspect the `harness_broken` metric and [`benchmark/HARNESS-AUDIT.md`](../../benchmark/HARNESS-AUDIT.md). Also note: **success-rate numbers from before the D1 fix are not citable**.

### The nightly workflow goes red on forks every day

**Cause**: the reliability workflow skips entirely, without failing, when no API key is present; if it still goes red, check the secret configuration.

## Still stuck

When opening an issue, include:

- `step-pilot --version` (or the version in `package.json`)
- OS and Node version
- reproduction steps
- relevant logs from `~/.step-pilot/` — **redact them first**, never paste an API key

For security issues see [`SECURITY.md`](../../SECURITY.md).
