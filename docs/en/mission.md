# Mission: recoverable engineering tasks (P0-A landed)

> **Status: the basic fact chain is implemented; recovery and verification are still design.**
>
> Implemented (P0-A): `step mission create / list / show / status / replay` — Mission manifest, append-only event log, pure state machine, explicit warnings for sequence gaps and illegal transitions.
>
> Not implemented: `resume` / `verify` / `prove`. Those three commands return exit code 2 instead of pretending to succeed. The recovery loop is P0-B; the independent verifier and evidence bundle are P0-C.

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

Implemented (P0-A):

```bash
step mission create --objective "Fix duplicate payment charges" --acceptance "pnpm vitest run" --max-turns 30
step mission list
step mission show <mission-id>
step mission status <mission-id>
step mission replay <mission-id>          # read-only replay: no side effects, no notifications, no writes
```

`create` options:

| Option | Meaning |
|--------|---------|
| `--objective <text>` | Task objective, required |
| `--acceptance <command>[:<expected exit>]` | Repeatable; expected exit defaults to 0. Split only on a **trailing** `:<digits>`, so colons inside the command survive |
| `--max-turns <n>` / `--max-attempts <n>` | Budget recorded only (P0-A does not enforce) |
| `--permission <manual\|auto\|yolo>` | Records the intended permission mode |
| `--repo <path>` | Owning repository, defaults to the current directory |

Not implemented (explicitly exit code 2):

```bash
step mission resume <mission-id> --from <checkpoint-id>   # P0-B
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

## Storage layout and honesty constraints

```text
~/.step-pilot/missions/<repo bucket>/<missionId>.json          # manifest (atomic tmp+rename)
~/.step-pilot/missions/<repo bucket>/<missionId>.events.jsonl  # event log (append-only, fact source)
```

Mission events are **not** written into the session `wire.jsonl`: the two lifecycles differ, and mixing them would let task state pollute session recovery.

Several constraints are deliberately built so the system cannot lie:

- `completed` can **only** be triggered by `verification.completed(passed=true)`. `status_changed` always refuses to set it — forging that event shows up in `status` as a skipped illegal transition, and the state does not change.
- Event `seq` is "current max + 1", not "line count + 1", so gaps are detectable; `status` lists the missing sequence numbers.
- Corrupt log lines are skipped and counted, and `status` surfaces them as `warning:` lines rather than swallowing them.
- `replay` is explicitly labeled read-only and never schedules agents, sends notifications, or writes to disk.
- A Mission created without acceptance criteria gets an explicit note, and will not be judged complete without machine evidence.

## Event envelope

Mission events live in their own fact source (`<missionId>.events.jsonl`), one event per line. Envelope fields are **camelCase**, matching the implementation:

```json
{
  "eventId": "evt-3f2a9c1b7d40",
  "seq": 2,
  "ts": "2026-09-14T15:00:00.000Z",
  "missionId": "mission-20260914150000-a4db29",
  "attemptId": "attempt-1",
  "type": "checkpoint.created",
  "checkpointId": "cp-001",
  "label": "payment.ts fixed, unit tests green"
}
```

Implemented event types:

| type | Payload | Meaning |
|------|---------|---------|
| `mission.created` | `repo` `objective` `acceptanceCount` | First event, written by `create` |
| `mission.status_changed` | `from` `to` `reason?` | Ordinary transition; `to === 'completed'` is **rejected** |
| `checkpoint.created` | `checkpointId` `label` | Records a recovery point |
| `recovery.started` | `fromCheckpointId?` `reason` | A recovery begins |
| `recovery.completed` | `replayedEvents` | Recovery ends, recording how many events were replayed |
| `verification.completed` | `verifierId` `passed` | `passed=true` is the **only** way into `completed` |

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

Landed (P0-A):

- Mission manifest, event log, pure state machine, and the `create/list/show/status/replay` commands.
- Event sequence gap detection, corrupt-line counting, explicit warnings for illegal transitions.
- State bound to verification: `completed` can only be triggered by a passing verification.
- Regression: `tests/agent/mission/state.test.ts` (19 cases), `tests/agent/mission/store.test.ts` (21 cases).

Still missing:

- **Recovery loop (P0-B)**: Mission is not yet wired to agent orchestration, checkpoint alignment, or subagent resume.
- **Independent verifier and evidence bundle (P0-C)**: `acceptance` is recorded only; nothing executes it yet, and `mission verify` / `prove` return exit code 2.
- **Fault-injection benchmark (P0-D)**: RCR has no data yet.
- **Journal identity fingerprints (P1)**: the `dynamic_workflow` journal key still needs script/model/provider/capability/git HEAD fingerprints to avoid incorrect cache hits.
- **True background abort (P1)**: background `dynamic_workflow` `task_stop` currently only marks killed.
- **Commits and events are not atomic**: there is no cross-store transaction; drift and recovery boundaries must be explicit.

> Sections marked "implemented" have tests and runtime evidence. Sections marked P0-B/C/D/P1 are design — do not present them as current capabilities.
