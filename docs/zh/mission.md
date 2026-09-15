# Mission：可恢复工程任务（P0-A 已落地）

> **状态：基础事实链已实现，恢复与验证仍是设计。**
>
> 已实现（P0-A）：`step mission create / list / show / status / replay`——Mission manifest、append-only 事件日志、纯函数状态机、事件序号缺口与非法迁移的显式告警。
>
> 未实现：`resume` / `verify` / `prove`。这三个命令当前明确返回退出码 2，不会假装成功。恢复闭环属 P0-B，独立 verifier 与 evidence bundle 属 P0-C。

## 为什么需要 Mission

普通会话恢复主要解决“继续看到之前的对话”。Mission 要解决更严格的问题：

- 进程被杀后，已经完成的代码工作能否保留？
- 模型失败、验证失败、验证环境故障能否区分？
- 是否可以只重跑失败的工作单元，而不是从头再来？
- “完成”是否有独立 verifier 和可检查证据，而不是模型自报？

Step Pilot 已有一组可复用的底层能力：`SessionStore`、append-only `wire.jsonl`、snapshot/tail replay、悬空 `tool_use` 闭合、子 agent 会话恢复、dynamic workflow journal、后台任务对账、Team worktree 门禁和 benchmark harness。Mission 计划把它们统一成一个产品级事实链。

## Session 与 Mission 的边界

| 概念 | 解决的问题 | 事实内容 |
|------|------------|----------|
| Session | 保存和恢复一次对话 | 消息、会话级设置、队列、goal 快照 |
| Mission | 完成一项可验证的工程任务 | 目标、接受标准、工作单元、attempt、checkpoint、失败、恢复和 evidence |

Mission 不替代 Session：Session 仍是对话载体，Mission 是跨会话、跨恢复过程的任务控制面。

## v0.1 目标

1. **工作不丢**：中断后从持久化 checkpoint 和事件尾部恢复。
2. **恢复可控**：用户可以查看 status、replay、resume，而不是重新描述任务。
3. **完成可证明**：独立 verifier 通过后才进入 `completed`。

## v0.1 范围

首期采用最小垂直切片：**单仓、单 Mission、单 worker、线性 work unit**。

manifest 实际落盘形态（`~/.step-pilot/missions/<repo 桶>/<missionId>.json`）：

```json
{
  "manifestVersion": 1,
  "missionId": "mission-20260914150000-a4db29",
  "repo": "D:/workspace/project",
  "objective": "修复支付模块的重复扣款问题",
  "acceptance": [
    { "command": "pnpm vitest run", "expectExit": 0, "description": "单测全绿" }
  ],
  "policy": { "maxAttempts": 3, "maxTurns": 30, "permission": "manual" },
  "createdAt": "2026-09-14T15:00:00.000Z"
}
```

> 接受标准当前只支持「命令 + 期望退出码」。`changed_files` 这类断言属 P0-C 的 verifier 阶段。

状态机（已实现）：

```text
planned → running → paused → recovering → verifying → completed
                    ↘ failed / blocked / stopped
```

状态语义：

- `completed`：验证通过（`verification.completed` 且 `passed=true`）。evidence bundle 属 P0-C，尚未生成。
- `failed`：执行或验证失败，但事实链完整，允许再次 resume（resume 本身属 P0-B）。
- `blocked`：缺少权限、外部服务或人工决策。
- `stopped`：用户要求停止，并已确认底层 worker / 子 agent 进入终态。
- `completed` 与 `stopped` 是终态，无出边；要再来一次就新建 Mission。

## 命令入口

已实现（P0-A）：

```bash
step mission create --objective "修复支付模块重复扣款" --acceptance "pnpm vitest run" --max-turns 30
step mission list
step mission show <mission-id>
step mission status <mission-id>
step mission replay <mission-id>          # 只读重放：不执行副作用、不发送通知、不写盘
```

`create` 的选项：

| 选项 | 说明 |
|------|------|
| `--objective <文本>` | 任务目标，必填 |
| `--acceptance <命令>[:<期望退出码>]` | 可重复；缺省期望退出码 0。只在**末尾**的 `:<数字>` 上切分，命令内的冒号不会被切坏 |
| `--max-turns <n>` / `--max-attempts <n>` | 预算登记（P0-A 只记录，不强制） |
| `--permission <manual\|auto\|yolo>` | 记录创建时的权限意图 |
| `--repo <路径>` | 任务所属仓库，缺省当前目录 |

未实现（明确返回退出码 2，不假装成功）：

```bash
step mission resume <mission-id> --from <checkpoint-id>   # P0-B
step mission verify <mission-id>                          # P0-C
step mission prove <mission-id> --out mission-proof/       # P0-C
```

交互界面未来也应显示：

```text
[Mission] running · checkpoint cp-003 · 2 recoveries
[Work unit] verify integration tests
[Last event] tool failure: command timeout
[Proof] pending — verifier not yet run
```

## 存储布局与诚实性约束

```text
~/.step-pilot/missions/<repo 桶>/<missionId>.json          # manifest（tmp+rename 原子写）
~/.step-pilot/missions/<repo 桶>/<missionId>.events.jsonl  # 事件日志（只追加，事实源）
```

Mission 事件**不写进会话 `wire.jsonl`**：两者生命周期不同，混写会让会话恢复被任务状态污染。

几条刻意设计成「不会说谎」的约束：

- `completed` **只能**由 `verification.completed(passed=true)` 触发。`status_changed` 一律拒绝置位 completed——伪造这条事件会在 `status` 里被标为「非法状态迁移被跳过」，且状态不变。
- 事件 `seq` 取「现有最大序号 + 1」而非「行数 + 1」，缺口因此可检测；`status` 会列出缺失序号。
- 日志损坏行会被跳过并计数，`status` 输出 `warning:` 行显式暴露，而不是静默吞掉。
- `replay` 明确标注只读，且不会因为重放而调度 agent、发送通知或写盘。
- 没有接受标准的 Mission 在 `create` 时会得到提示，且不会因为没有依据而被判完成。

## Event envelope

Mission 事件建立在独立的事实源之上（`<missionId>.events.jsonl`），每行一个事件。信封字段是**驼峰**，与实现一致：

```json
{
  "eventId": "evt-3f2a9c1b7d40",
  "seq": 2,
  "ts": "2026-09-14T15:00:00.000Z",
  "missionId": "mission-20260914150000-a4db29",
  "attemptId": "attempt-1",
  "type": "checkpoint.created",
  "checkpointId": "cp-001",
  "label": "改完 payment.ts，单测通过"
}
```

已实现的事件类型：

| type | 载荷 | 说明 |
|------|------|------|
| `mission.created` | `repo` `objective` `acceptanceCount` | 首条事件，由 `create` 写入 |
| `mission.status_changed` | `from` `to` `reason?` | 常规状态迁移；**不允许** `to === 'completed'` |
| `checkpoint.created` | `checkpointId` `label` | 记录一个可恢复点 |
| `recovery.started` | `fromCheckpointId?` `reason` | 开始一次恢复 |
| `recovery.completed` | `replayedEvents` | 恢复结束，记录本次重放条数 |
| `verification.completed` | `verifierId` `passed` | `passed=true` 是进入 `completed` 的**唯一**入口 |

`seq` 从 1 开始单调递增，用于缺口检测。恢复必须是只读重放：不能在 replay 中重新调度 agent、发送通知或写入新的事件。第三方 API 副作用也不会因为 Mission resume 自动回滚。

后续阶段计划补充的标识：`workUnitId`、`faultId`、`resumeFromCheckpointId`、`gitHeadBefore`、`gitHeadAfter`、`evidencePath`。

## Evidence bundle

Mission 完成或失败都应生成可检查的证据包：

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

证据包只能证明 verifier 覆盖的本地条件，不能证明远程生产系统或第三方副作用已经回滚。

## RCR 指标

Mission 的北极星指标计划为 **Recovery-Complete Rate（RCR）**：

> 在受控中断后，Mission 从持久化断点恢复，并最终通过独立 verifier 的比例。

RCR 不能由模型自报成功替代。相关分层指标包括：

- checkpoint 存活率与变更保全率
- 恢复后重复 token 比例
- journal 命中率与恢复后首个有效动作延迟
- verifier 通过率
- `harness_error` 与 `verification_skipped`
- 悬空工具调用闭合数
- evidence 事件完整率

Benchmark 必须区分 clean run、kill-before-checkpoint、kill-after-checkpoint、kill-during-tool、resume 和 verifier harness error，并与无中断 oracle 成对比较。

## Non-goals

v0.1 不做：

- 多仓 Mission、远程控制面或云端同步
- 任意复杂 DAG 和分布式 workflow 平台
- 自动 merge 或第三方副作用回滚
- 新 MCP transport、新 provider 扩张、Web UI
- 无条件 journal 缓存
- 将模型自报成功当作完成证明

## 实现状态与已知风险

已落地（P0-A）：

- Mission manifest、事件日志、纯函数状态机、`create/list/show/status/replay` 命令。
- 事件序号缺口检测、损坏行计数、非法迁移显式告警。
- 状态与「完成」的绑定：`completed` 只能由通过的验证触发。
- 回归：`tests/agent/mission/state.test.ts`（19 例）、`tests/agent/mission/store.test.ts`（21 例）。

仍未完成：

- **resume 闭环（P0-B）**：还没有把 Mission 与 agent 编排、checkpoint 对齐、子会话 resume 接起来。
- **独立 verifier 与 evidence bundle（P0-C）**：`acceptance` 目前只是登记，没有任何代码执行它；`mission verify` / `prove` 返回退出码 2。
- **fault-injection benchmark（P0-D）**：RCR 尚无数据。
- **journal 身份指纹（P1）**：`dynamic_workflow` 的 journal key 仍需补充 script/model/provider/capability/git HEAD 指纹，避免错误缓存命中。
- **后台真正 abort（P1）**：`dynamic_workflow` 后台 `task_stop` 目前只标记 killed。
- **commit 与事件非原子**：跨存储没有事务，需要显式记录 drift 和恢复边界。

> 本页中标注「已实现」的部分有测试与运行证据；标注 P0-B/C/D/P1 的部分是设计，不要当成当前能力对外表述。
