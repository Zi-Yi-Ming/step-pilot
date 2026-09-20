# Mission：可恢复工程任务（P0-A + P0-B + P0-C + P0-D 已落地）

> **状态：事实链、恢复分析与独立 verifier 均已实现。**
>
> 已实现：`step mission create / list / show / status / replay / start / pause / stop / checkpoint / resume / verify / prove`——Mission manifest、append-only 事件日志、纯函数状态机、检查点（含 git HEAD 对齐）、恢复分析（漂移判定 + 悬空工具调用检测 + 副作用账本 + 需确认清单），以及独立 verifier（执行 `acceptance` 命令、比对退出码、写证据，且把 harness 故障与断言失败分开）。
>
> `verify` 是唯一能把 Mission 推到 `completed` 的路径；`prove` 在其基础上导出可检查的证据包目录。
>
> `resume --confirm` 重建事实链并记录恢复事件；`resume --confirm --run` 在此之上把合成的续跑 prompt 交给组合根，以非交互模式真实继续任务（显式 opt-in：烧 token）。无论是否 `--run`，完成判定都只归 `step mission verify`——agent 跑完不代表 completed。

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

> 接受标准当前支持两类机器判定：**「命令 + 期望退出码」**（独立 verifier 逐条执行并比对退出码）与**「范围约束」（`--allow-files`，见下文）**。`unused_exports` 这类更深入的结构化断言属后续 verifier 阶段。

状态机（已实现）：

```text
planned → running → paused → recovering → verifying → completed
                    ↘ failed / blocked / stopped
```

状态语义：

- `completed`：验证通过（`verification.completed` 且 `passed=true`）。证据包由 `verify` 写盘、`prove` 导出。
- `failed`：执行或验证失败，但事实链完整，允许再次 resume（resume 本身属 P0-B）。
- `blocked`：缺少权限、外部服务或人工决策。
- `stopped`：用户要求停止，并已确认底层 worker / 子 agent 进入终态。
- `completed` 与 `stopped` 是终态，无出边；要再来一次就新建 Mission。

## 命令入口

生命周期：

```bash
step mission create --objective "修复支付模块重复扣款" --acceptance "pnpm vitest run" --max-turns 30
step mission start  <mission-id> [--reason "开工"]     # planned/paused/failed/blocked → running
step mission pause  <mission-id> [--reason "等外部依赖"]  # running → paused
step mission stop   <mission-id> [--reason "放弃"]     # 终态，不可复活
step mission list
step mission show   <mission-id>
step mission status <mission-id>
step mission replay <mission-id>          # 只读重放：不执行副作用、不发送通知、不写盘
```

恢复：

```bash
step mission checkpoint <mission-id> --label "改完 payment.ts，单测通过" [--allow-dirty]
step mission resume <mission-id>                        # 只读恢复分析
step mission resume <mission-id> --confirm              # 记录恢复（recovery.started + recovery.completed → running）
step mission resume <mission-id> --confirm --run        # 记录后交给组合根以非交互模式继续任务（真实烧 token）
```

`create` 的选项：

| 选项 | 说明 |
|------|------|
| `--objective <文本>` | 任务目标，必填 |
| `--acceptance <命令>[:<期望退出码>]` | 可重复；缺省期望退出码 0。只在**末尾**的 `:<数字>` 上切分，命令内的冒号不会被切坏。`verify` 会逐条执行这些命令并比对退出码 |
| `--allow-files <glob>` | 可重复；范围约束：`verify` 时自**第一个检查点的 HEAD**起检查全部变更文件（提交 ∪ 未提交，含删除与未跟踪），每个文件须至少匹配一条 glob（`**` 跨目录段、`*` 不跨、`?` 单字符），越界即验收不通过 |
| `--max-turns <n>` / `--max-attempts <n>` | 预算登记（当前只记录，不强制） |
| `--permission <manual\|auto\|yolo>` | 记录创建时的权限意图 |
| `--session <会话 id>` | 关联会话，让 `resume` 能发现悬空工具调用；同时让会话启动时把 Mission 约束钉进 system（见「约束钉扎」） |
| `--repo <路径>` | 任务所属仓库，缺省当前目录 |

`checkpoint` 的两个刻意拒绝：

- **终态与 planned 不接受检查点**：没有可恢复的东西，记录了只会误导。
- **工作区不干净时默认拒绝**，必须显式 `--allow-dirty`。理由是「默认允许」会让 resume 端把不干净误读成干净；让调用方显式承担这个判断，并在事件里标 `dirty: true`。

`verify` / `prove`（P0-C，已实现）：

```bash
step mission verify <mission-id> [--reason <文本>]     # 跑 acceptance 命令，独立判定完成；证据写盘
step mission prove <mission-id> [--out <目录>]         # verify 并导出可检查的证据包（mission-proof/<id>/）
```

- `verify` 进入 `verifying`（running/recovering/verifying 直达；paused/failed/blocked 先桥接回 running），逐条执行 `acceptance` 命令、比对退出码，落 `verification.completed`。全部通过 → `completed`；断言失败 → `failed`；**环境故障（harness error）→ 退回 running，绝不置 completed/failed**。
- **范围检查（manifest.scope 声明时）**：以**第一个检查点**的 HEAD 为基线（范围约束约束的是「本任务改了什么」，最近检查点会漏掉中间已提交的改动），git 提交层变更 ∪ 未提交变更逐个比对 `allowFiles`。越界 → 验收不通过（`failed`）；无基线 / git 不可用 / sha 被 rebase → **不可判定**，按 harness 语义退回 running——绝不把「查不了」读成「没越界」。
- `prove` 复用同一条验证核心，额外把 `manifest.json` / `timeline.json` / `verifier-results.json` / `evidence.json` / `README.md` 写到证据包目录；范围检查结果包含在 evidence 中。

交互界面未来也应显示：

```text
[Mission] running · checkpoint cp-003 · 2 recoveries
[Work unit] verify integration tests
[Last event] tool failure: command timeout
[Proof] pending — verifier not yet run
```

## 恢复分析（`mission resume`）

`resume` 默认**只读**：不写事件、不调度、不发通知。它回答的是「现在能不能继续、有哪些不确定」，
把「怎么继续」留给调用方。

输出包含：

- **可恢复性**：直接复用状态机的迁移表（`canTransition(status, 'recovering')`），不另立一套判断。
  `planned`（尚未开始）与 `completed` / `stopped`（终态）不可恢复。
- **漂移判定**：最近检查点的 HEAD 与当前 HEAD 对比，分四类——`none` / `uncommitted` / `committed` / `unknown`。
  **`unknown` 是一等结论**：检查点没记 HEAD、git 不可用、空仓、HEAD 变了却列不出文件（rebase 改写历史）
  都会如实报「无法判定」，绝不降级成「无漂移」。
- **关联会话**：manifest 记了 `--session` 时，用 `SessionStore.resume()` 检出末尾悬空 `tool_use`
  （进程死在工具中途的证据），并进「需要确认」。
- **副作用账本**：从会话消息确定性推导「可能改变世界」的调用（write_file / edit_file / bash
  按名分类；MCP、spawn_agent、dynamic_workflow 等未知工具保守纳入；只读白名单不进账本）
  及其闭环状态。**未闭环**（悬空，或结果被中断占位替换）→ 进「需要确认」——进程可能死在
  副作用中途，文件可能处于半写状态；**已失败**→ 进告警（失败也是事实，恢复时不要假装它成功过）。
  账本是会话事实源的纯函数推导，不在 Mission 事件日志里另记一份（避免第二份会漂移的记录）。
- **需要确认清单**：脏检查点、检查点后的变更归属、悬空工具调用、未闭环副作用、接受标准尚未执行……
  任何一项不确定都进这里，不因为「大概率没事」静默放行。

`--confirm` 才写事件：`recovery.started`（→ `recovering`）+ `recovery.completed`（→ `running`）。
`--run` 在 `--confirm` 之上把续跑交给组合根：恢复事实链先落盘，然后由 `buildContinuationPrompt`
把恢复分析观察到的事实（目标、检查点、漂移、未决项、告警）合成英文续跑 prompt，
进程落穿到 agent 引导以非交互模式继续任务。`--run` 不带 `--confirm` 会被拒绝——
真实启动 agent 会烧 token，不允许在只读分析里隐式发生。无论哪种形式，resume 都不执行接受标准，
也不宣称完成——完成判定只归 `step mission verify`。

### 约束钉扎（system 注入）

会话启动 / 恢复时，若本目录存在 `--session <本会话 id>` 关联的**非终态** Mission，
组合根会把它的目标、验收命令与范围 glob 作为一段「Associated Mission (pinned constraints)」
拼进 system（`composeSystem` 的 mission 段，位于 AGENTS.md 与 memory 之间）。设计要点：

- **放 system 而不是压缩后重注入**：压缩只重写 messages，从不触碰 system——约束放进 system
  就天然跨压缩存活，「约束如何被持续钉住」是结构解，不依赖压缩路径的时序。
- **诚实性**：状态是启动时快照（system 静态，不随 Mission 推进更新）；正文明确
  「完成判定只归 `step mission verify`」。终态（completed/stopped）Mission 不注入。
- 与 `resume --confirm --run` 组合：桥接续跑恢复 manifest 关联的会话，约束段与续跑 prompt
  同时生效——执行期钉住约束、收尾期机器判定范围，形成闭环。
- 已知限制：会话中途创建的 Mission 要到下次启动/恢复才被钉进 system；子 agent 不自动继承
  约束段（委派时依赖主 agent 按系统提示把背景写全，越界最终仍被 verify 拦截）。

## 存储布局与诚实性约束

```text
~/.step-pilot/missions/<repo 桶>/<missionId>.json          # manifest（tmp+rename 原子写）
~/.step-pilot/missions/<repo 桶>/<missionId>.events.jsonl  # 事件日志（只追加，事实源）
```

Mission 事件**不写进会话 `wire.jsonl`**：两者生命周期不同，混写会让会话恢复被任务状态污染。

几条刻意设计成「不会说谎」的约束：

- `completed` **只能**由 `verification.completed(passed=true)` 触发。`status_changed` 一律拒绝置位 completed——伪造这条事件会在 `status` 里被标为「非法状态迁移被跳过」，且状态不变。
- **校验在写入侧**：`appendEvent()` 落盘前先用状态机校验，非法迁移直接抛错、**不写进事实源**。读取侧的容错（跳过并计数）只用来兜「外部改写 / 手工编辑」这一种情况，不是给自家写入擦屁股的。
- 事件 `seq` 取「现有最大序号 + 1」而非「行数 + 1」，缺口因此可检测；`status` 会列出缺失序号。
- 日志损坏行会被跳过并计数，`status` 输出 `warning:` 行显式暴露，而不是静默吞掉。
- `replay` 与不带 `--confirm` 的 `resume` 明确标注只读，且不会因为重放而调度 agent、发送通知或写盘。
- 没有接受标准的 Mission 在 `create` 时会得到提示，且不会因为没有依据而被判完成。
- 状态机为了**重放容错**允许同状态迁移（`from === to`），但命令层拒绝把空操作写成事件——不往事实源里灌噪音。

## Event envelope

Mission 事件建立在独立的事实源之上（`<missionId>.events.jsonl`），每行一个事件。信封字段是**驼峰**，与实现一致：

```json
{
  "eventId": "evt-3f2a9c1b7d40",
  "seq": 3,
  "ts": "2026-09-15T02:59:09.065Z",
  "missionId": "mission-20260915025903-b4fc0a",
  "attemptId": "attempt-1",
  "type": "checkpoint.created",
  "checkpointId": "cp-001",
  "label": "起点：已定位到 payment.ts",
  "gitHead": "bbb574e022f1...",
  "dirty": false
}
```

已实现的事件类型：

| type | 载荷 | 状态影响 | 说明 |
|------|------|----------|------|
| `mission.created` | `repo` `objective` `acceptanceCount` | 无 | 首条事件，由 `create` 写入 |
| `mission.status_changed` | `from` `to` `reason?` | → `to` | 常规状态迁移；**不允许** `to === 'completed'` |
| `checkpoint.created` | `checkpointId` `label` `gitHead?` `changedFiles?` `dirty?` | 无 | 记录一个恢复点，并锚定当时的 HEAD |
| `recovery.started` | `fromCheckpointId?` `reason` | → `recovering` | 开始一次恢复；`planned` / 终态上非法 |
| `recovery.completed` | `replayedEvents` | → `running` | 恢复结束；回到 `running` 而不是退回恢复前的失败态 |
| `verification.completed` | `verifierId` `passed` `harnessError?` `evidenceRef?` | → `completed` / `failed` / （harness 故障则退回 `running`） | `passed=true` 是进入 `completed` 的**唯一**入口；`harnessError=true` 表示环境故障而非断言失败，绝不据此置 completed/failed |

`seq` 从 1 开始单调递增，用于缺口检测。恢复必须是只读重放：不能在 replay 中重新调度 agent、发送通知或写入新的事件。第三方 API 副作用也不会因为 Mission resume 自动回滚。

后续阶段计划补充的标识：`workUnitId`、`faultId`、`resumeFromCheckpointId`、`gitHeadBefore`、`gitHeadAfter`。（`evidencePath` 已由 `verification.completed.evidenceRef` 落地：证据文件落在 `<missionId>.evidence/` 下，事件日志只存引用。）

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
- 悬空工具调用闭合数与未闭环副作用数（副作用账本）
- evidence 事件完整率

Benchmark 必须区分 clean run、kill-before-checkpoint、kill-after-checkpoint、kill-during-tool、resume 和 verifier harness error，并与无中断 oracle 成对比较。

### 已实现（P0-D）

```bash
pnpm benchmark rcr        # 跑全部场景并输出 RCR
```

实现要点（`benchmark/faultInjection.ts`）：

- **中断 = 事实链在某个点结束**。真实崩溃后能留下的就是事件日志的某个前缀，所以「杀掉进程」等价于「把 `<missionId>.events.jsonl` 截断到第 N 条」。因此不需要真杀进程——装置快、确定、可重复，而它检验的正是恢复逻辑真正依赖的东西。
- **每个场景跑真实 Mission 生命周期**（`MissionStore` + 状态机 + `create/start/checkpoint/resume/verify`），只注入两样：verifier 的 shell 执行器、以及会话存储（`MissionRunOptions.sessionStore`，避免污染真实 `~/.step-pilot`）。
- **clean 是无中断 oracle**，它不走恢复路径；其余场景注入故障后必须经 `resume --confirm` 才能继续。
- **harness 故障单独计数**：环境坏了既不是「恢复成功」也不是「恢复失败」，只进 `harnessErrorRuns`，绝不计入 recovered。

首次读数（2026-09-20，五个场景各一次）：

| 场景 | 结果 | 终态 | 验证 |
|------|------|------|------|
| clean（oracle） | 恢复 | completed | passed |
| kill-before-checkpoint | 恢复 | completed | passed |
| kill-after-checkpoint | 恢复 | completed | passed |
| kill-during-tool | 恢复（闭合 1 个悬空调用） | completed | passed |
| verifier-harness-error | 不可判定 | running | harness-error |

**RCR = 80%（4/5）**，其中 1 例因环境故障不可判定、单独计数。

> 注意样本量：这是 5 个场景各 1 次的功能性读数，用来证明装置可用、且不变量成立；**不是统计结论**，不要据此声称稳定性百分比。

## Non-goals

v0.1 不做：

- 多仓 Mission、远程控制面或云端同步
- 任意复杂 DAG 和分布式 workflow 平台
- 自动 merge 或第三方副作用回滚
- 新 MCP transport、新 provider 扩张、Web UI
- 无条件 journal 缓存
- 将模型自报成功当作完成证明

## 实现状态与已知风险

已落地：

- **P0-A**：Mission manifest、事件日志、纯函数状态机、`create/list/show/status/replay` 命令。
- **P0-B**：`start/pause/stop` 生命周期命令、`checkpoint`（git HEAD 对齐 + 脏工作区拒绝）、
  `resume`（漂移判定 + 悬空工具调用检测 + 副作用账本 + 需确认清单 + `--confirm` 记录恢复）。
- **P0-C**：独立 verifier（执行 `acceptance`、比对退出码、写证据包，harness 故障与断言失败分开）
  与 `prove` 证据包导出；`--allow-files` 范围验收；`resume --confirm --run` 把恢复接回执行。
- **P0-D**：fault-injection benchmark + RCR（见下节），`pnpm benchmark rcr`。
- 写入侧校验：非法迁移在落盘前抛错，事实源不会出现非法事件。
- 事件序号缺口检测、损坏行计数、非法迁移显式告警。
- 回归：`tests/agent/mission/` 六个套件共 148 例；fault-injection 另有 `tests/analysis/faultInjection.test.ts` 11 例。

仍未完成：

- **接入 agent 编排（P0-B 后半）**：`resume --confirm --run` 已把恢复接回执行（续跑 prompt + 组合根落穿 + 会话恢复）；
  但 TUI 内的交互式续跑、按 Mission 策略（policy.permission）约束续跑权限，仍是待办。
- **更丰富的接受标准（P0-C 延伸）**：范围断言（`--allow-files`）已落地；`unused_exports` 等
  更深入的结构化断言是后续 verifier 阶段，不是当前能力。
- **fault-injection benchmark 样本量（P0-D 延伸）**：装置已可用并有首次读数（RCR 80%，5 场景各 1 次）；
  但要成为统计结论，需要多轮重复、并接入夜间采集。
- **effect ledger 事件化（可选延伸）**：逐副作用 started/completed 账本已作为会话事实源的
  **推导视图**落地（resume 分析用）；若未来需要跨会话聚合或在不关联会话时保留账本，
  再考虑把 `effect.started/completed` 写进 Mission 事件日志。
- **journal 身份指纹（P1）**：`dynamic_workflow` 的 journal key 仍需补充
  script/model/provider/capability/git HEAD 指纹，避免错误缓存命中。
- **后台真正 abort（P1）**：`dynamic_workflow` 后台 `task_stop` 目前只标记 killed。
- **commit 与事件非原子**：跨存储没有事务，漂移只能事后检测，不能预防。

> 本页中标注「已实现」的部分有测试与运行证据；标注 P1 的部分是设计，不要当成当前能力对外表述。
