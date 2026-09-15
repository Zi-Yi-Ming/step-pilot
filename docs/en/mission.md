# Mission: recoverable engineering tasks (P0-A + P0-B landed)

> **Status: the fact chain and recovery analysis are implemented; independent verification and the evidence bundle are still design.**
>
> Implemented: `step mission create / list / show / status / replay / start / pause / stop / checkpoint / resume` — Mission manifest, append-only event log, pure state machine, checkpoints (with git HEAD alignment), and recovery analysis (drift detection, dangling tool-call detection, confirmation list).
>
> Not implemented: `verify` / `prove`. Those two return exit code 2 instead of pretending to succeed (the independent verifier and evidence bundle are P0-C).
>
> `resume --confirm` only rebuilds the fact chain and records the recovery — it does **not** start an agent. Wiring it into the PiChat composition root is follow-up work.

## Why Mission

Ordinary session resume mainly answers: “Can I see the previous conversation again?” Mission asks stricter questions:

- If the process is killed, is completed code work preserved?
- Can model failure, verification failure, and harness failure be distinguished?
- Can only the failed work unit be rerun instead of starting over?
- Is “completed” backed by an independent verifier and inspectable evidence rather than the model’s claim?

Step Pilot already has reusable foundations: `SessionStore`, append-only `wire.jsonl`, snapshot/tail replay, dangling `tool_use` closure, persisted subagent sessions, dynamic-workflow journals, background reconciliation, Team worktree gates, and the benchmark harness. Mission is intended to unify them into a product-level fact chain.

## Session versus Mission

| Concept | Problem solved | Facts represented |
|---------|-----------------|-------------------|
| Session | Save and resume a conversation | Messages, session settings, queue, goal snapshot |
| Mission | Complete one verifiable engineering task | Objective, acceptance criteria, work units, attempts, checkpoints, failures, recovery, evidence |

Mission does not replace Session. Session remains the conversation container; Mission is the task control plane across sessions and recoveries.

## v0.1 goals

1. **Preserve work**: recover from a persisted checkpoint and event tail after interruption.
2. **Control recovery**: let users inspect status, replay facts, and resume without restating the task.
3. **Prove completion**: enter `completed` only after independent verification passes.

## v0.1 scope

The first vertical slice is deliberately small: **one repository, one Mission, one worker, linear work units**.

The manifest as actually written to disk (`~/.step-pilot/missions/<repo bucket>/<missionId>.json`):

```json
{
  "manifestVersion": 1,
  "missionId": "mission-20260914150000-a4db29",
  "repo": "D:/workspace/project",
  "objective": "Fix duplicate charges in the payment module",
  "acceptance": [
    { "command": "pnpm vitest run", "expectExit": 0, "description": "unit tests green" }
  ],
  "policy": { "maxAttempts": 3, "maxTurns": 30, "permission": "manual" },
  "createdAt": "2026-09-14T15:00:00.000Z"
}
```

> Acceptance currently supports only "command + expected exit code". Assertions like `changed_files` belong to the P0-C verifier stage.

State machine (implemented):

```text
planned -> running -> paused -> recovering -> verifying -> completed
                    \-> failed / blocked / stopped
```

State semantics:

- `completed`: verification passed (`verification.completed` with `passed=true`). The evidence bundle is P0-C and does not exist yet.
- `failed`: execution or verification failed, but the fact chain is intact and resume is allowed (resume itself is P0-B).
- `blocked`: permission, external service, or human decision is required.
- `stopped`: the user requested a stop and all underlying workers/subagents are confirmed terminal.
- `completed` and `stopped` are terminal with no outgoing edges; start a new Mission to try again.

## Commands

Lifecycle:

```bash
step mission create --objective "Fix duplicate payment charges" --acceptance "pnpm vitest run" --max-turns 30
step mission start  <mission-id> [--reason "starting"]      # planned/paused/failed/blocked -> running
step mission pause  <mission-id> [--reason "waiting on X"]  # running -> paused
step mission stop   <mission-id> [--reason "abandoned"]     # terminal, cannot be revived
step mission list
step mission show   <mission-id>
step mission status <mission-id>
step mission replay <mission-id>          # read-only replay: no side effects, no notifications, no writes
```

Recovery:

```bash
step mission checkpoint <mission-id> --label "payment.ts fixed, unit tests green" [--allow-dirty]
step mission resume <mission-id>            # read-only recovery analysis
step mission resume <mission-id> --confirm  # records recovery (recovery.started + recovery.completed -> running)
```

`create` options:

| Option | Meaning |
|--------|---------|
| `--objective <text>` | Task objective, required |
| `--acceptance <command>[:<expected exit>]` | Repeatable; expected exit defaults to 0. Split only on a **trailing** `:<digits>`, so colons inside the command survive |
| `--max-turns <n>` / `--max-attempts <n>` | Budget recorded only (not enforced yet) |
| `--permission <manual\|auto\|yolo>` | Records the intended permission mode |
| `--session <session id>` | Associates a session so `resume` can find dangling tool calls |
| `--repo <path>` | Owning repository, defaults to the current directory |

Two deliberate refusals in `checkpoint`:

- **Terminal and `planned` Missions accept no checkpoint**: there is nothing to recover, so recording one would only mislead.
- **A dirty worktree is refused by default** and requires an explicit `--allow-dirty`. The reason: "allowed by default" would let the resume side read a dirty tree as clean. The caller takes that judgment explicitly, and the event is marked `dirty: true`.

Not implemented (explicitly exit code 2):

```bash
step mission verify <mission-id>                          # P0-C
step mission prove <mission-id> --out mission-proof/       # P0-C
```

The future TUI should also show:

```text
[Mission] running · checkpoint cp-003 · 2 recoveries
[Work unit] verify integration tests
[Last event] tool failure: command timeout
[Proof] pending — verifier not yet run
```

## Recovery analysis (`mission resume`)

`resume` is **read-only** by default: it writes no events, schedules nothing, and sends no notifications. It answers "can we continue, and what is uncertain", leaving "how to continue" to the caller.

The output covers:

- **Resumability**: derived directly from the state machine's transition table (`canTransition(status, 'recovering')`), not a second parallel rule. `planned` (never started) and `completed` / `stopped` (terminal) are not resumable.
- **Drift**: the last checkpoint's HEAD compared against the current HEAD, classified as `none` / `uncommitted` / `committed` / `unknown`. **`unknown` is a first-class result**: a checkpoint with no recorded HEAD, unavailable git, an empty repository, or a changed HEAD with no listable files (history rewritten) all report "cannot determine" rather than degrading to "no drift".
- **Associated session**: when the manifest records `--session`, `SessionStore.resume()` detects a trailing dangling `tool_use` (evidence the process died mid-tool) and adds it to the confirmation list.
- **Confirmation list**: dirty checkpoints, ownership of post-checkpoint changes, dangling tool calls, acceptance criteria never executed. Any uncertainty lands here instead of being waved through because it is "probably fine".

Only `--confirm` writes events: `recovery.started` (-> `recovering`) plus `recovery.completed` (-> `running`). Even with `--confirm` it does not start an agent and does not execute acceptance criteria.

## Storage layout and honesty constraints

```text
~/.step-pilot/missions/<repo bucket>/<missionId>.json          # manifest (atomic tmp+rename)
~/.step-pilot/missions/<repo bucket>/<missionId>.events.jsonl  # event log (append-only, fact source)
```

Mission events are **not** written into the session `wire.jsonl`: the two lifecycles differ, and mixing them would let task state pollute session recovery.

Several constraints are deliberately built so the system cannot lie:

- `completed` can **only** be triggered by `verification.completed(passed=true)`. `status_changed` always refuses to set it — forging that event shows up in `status` as a skipped illegal transition, and the state does not change.
- **Validation happens on the write side**: `appendEvent()` validates against the state machine before appending, so an illegal transition throws and is **never written into the fact source**. The tolerant read path (skip and count) exists only to handle externally edited or hand-edited logs — it is not there to clean up after our own writes.
- Event `seq` is "current max + 1", not "line count + 1", so gaps are detectable; `status` lists the missing sequence numbers.
- Corrupt log lines are skipped and counted, and `status` surfaces them as `warning:` lines rather than swallowing them.
- `replay`, and `resume` without `--confirm`, are explicitly labeled read-only and never schedule agents, send notifications, or write to disk.
- A Mission created without acceptance criteria gets an explicit note, and will not be judged complete without machine evidence.
- The state machine tolerates same-state transitions (`from === to`) for **replay** robustness, but the command layer refuses to write a no-op event — no noise in the fact source.

## Event envelope

Mission events live in their own fact source (`<missionId>.events.jsonl`), one event per line. Envelope fields are **camelCase**, matching the implementation:

```json
{
  "eventId": "evt-3f2a9c1b7d40",
  "seq": 3,
  "ts": "2026-09-15T02:59:09.065Z",
  "missionId": "mission-20260915025903-b4fc0a",
  "attemptId": "attempt-1",
  "type": "checkpoint.created",
  "checkpointId": "cp-001",
  "label": "start: payment.ts located",
  "gitHead": "bbb574e022f1...",
  "dirty": false
}
```

Implemented event types:

| type | Payload | State effect | Meaning |
|------|---------|--------------|---------|
| `mission.created` | `repo` `objective` `acceptanceCount` | none | First event, written by `create` |
| `mission.status_changed` | `from` `to` `reason?` | -> `to` | Ordinary transition; `to === 'completed'` is **rejected** |
| `checkpoint.created` | `checkpointId` `label` `gitHead?` `changedFiles?` `dirty?` | none | Records a recovery point anchored to the HEAD at that moment |
| `recovery.started` | `fromCheckpointId?` `reason` | -> `recovering` | A recovery begins; illegal on `planned` and terminal states |
| `recovery.completed` | `replayedEvents` | -> `running` | Recovery ends; returns to `running` rather than the pre-recovery failure state |
| `verification.completed` | `verifierId` `passed` | -> `completed` / `failed` | `passed=true` is the **only** way into `completed` |

`seq` starts at 1 and increases monotonically for gap detection. Recovery must be read-only replay: it never reschedules agents, sends notifications, or writes new events. Mission resume also cannot automatically roll back side effects in third-party APIs.

Identifiers planned for later stages: `workUnitId`, `faultId`, `resumeFromCheckpointId`, `gitHeadBefore`, `gitHeadAfter`, `evidencePath`.

## Evidence bundle

Both successful and failed Missions should produce inspectable evidence:

```text
mission-proof/
├── manifest.json
├── timeline.json
├── checkpoints.json
├── changed-files.patch
├── verifier-results.json
├── recovery-events.json
├── usage.json
└── unresolved-risks.md
```

An evidence bundle proves only the local conditions covered by its verifier. It does not prove that a remote production system or third-party side effect was rolled back.

## RCR metric

The planned Mission north-star metric is **Recovery-Complete Rate (RCR)**:

> The proportion of controlled interruptions from which a Mission recovers from a durable checkpoint and eventually passes an independent verifier.

RCR must not be replaced by the model’s self-reported success. Supporting metrics include:

- checkpoint survival and change-preservation rate
- duplicate tokens after recovery
- journal hit rate and time to first effective action after resume
- verifier pass rate
- `harness_error` and `verification_skipped`
- dangling tool-call closures
- evidence event completeness

The benchmark must separate clean runs, kill-before-checkpoint, kill-after-checkpoint, kill-during-tool, resume, and verifier harness errors, paired with an uninterrupted oracle.

## Non-goals

v0.1 does not include:

- multi-repository Missions, remote control planes, or cloud sync
- arbitrary DAGs or a distributed workflow platform
- automatic merge or third-party side-effect rollback
- new MCP transports, provider expansion, or a Web UI
- unconditional journal caching
- treating a model’s self-reported success as proof of completion

## Implementation status and known risks

Landed:

- **P0-A**: Mission manifest, event log, pure state machine, and the `create/list/show/status/replay` commands.
- **P0-B**: the `start/pause/stop` lifecycle commands, `checkpoint` (git HEAD alignment, dirty-worktree refusal), and `resume` (drift detection, dangling tool-call detection, confirmation list, `--confirm` to record the recovery).
- Write-side validation: illegal transitions throw before landing, so the fact source cannot contain illegal events.
- Event sequence gap detection, corrupt-line counting, explicit warnings for illegal transitions.
- Regression: `tests/agent/mission/state.test.ts` (19 cases), `store.test.ts`, `resume.test.ts` (35 cases).

Still missing:

- **Agent orchestration wiring (the rest of P0-B)**: `resume --confirm` only rebuilds the fact chain and records the recovery; it does not start an agent. Wiring it into the PiChat composition root so recovery actually continues the task is still open.
- **Independent verifier and evidence bundle (P0-C)**: `acceptance` is recorded only; nothing executes it, and `mission verify` / `prove` return exit code 2.
- **Fault-injection benchmark (P0-D)**: RCR has no data yet.
- **Effect ledger**: today there is only checkpoint + drift alignment, not a per-side-effect started/completed ledger. "Unresolved side effect -> needs_confirmation" is therefore expressed indirectly through drift, not as a precise effect-level judgment.
- **Journal identity fingerprints (P1)**: the `dynamic_workflow` journal key still needs script/model/provider/capability/git HEAD fingerprints to avoid incorrect cache hits.
- **True background abort (P1)**: background `dynamic_workflow` `task_stop` currently only marks killed.
- **Commits and events are not atomic**: there is no cross-store transaction, so drift can only be detected after the fact, not prevented.

> Sections marked "implemented" have tests and runtime evidence. Sections marked P0-C/D or P1 are design — do not present them as current capabilities.
