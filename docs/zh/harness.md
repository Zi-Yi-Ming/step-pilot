# Harness

> Step Pilot 的差异化不在「接了哪个模型」，而在**围绕模型刻意设计的 harness**。本页说明它的五个部分：上下文管理、重试、恢复、验证、轨迹。

## 为什么要有 harness

轻量模型（如 Step 3.7 Flash）快且便宜，但在传统 agent 脚手架下会崩：过长的系统提示、失控的工具输出、偷懒的压缩，会在真正的工作开始前就把上下文吃光。

Step Pilot 的命题是：

> **How far can a lightweight model go with the right harness?**
> 一个轻量模型，配上合适的 harness，能走多远？

因此下面每一项都是**工程约束**，不是装饰。

---

## 1. 上下文管理（Context Management）

上下文是预算，不是日志。

| 机制 | 默认行为 |
|------|---------|
| 系统提示 | ~2000 字符——最小可用指令集，不是百科全书 |
| 工具结果上限 | 单条 400K 字符，防止一次失控命令淹没模型 |
| 结果预处理 | `toolResultPreprocess` 对 grep / glob / web_fetch 等结果先规整再回灌 |
| 压缩触发 | 上下文占用 75% 时触发 |
| 压缩策略 | 全量摘要时保留最近 6 条消息；用户消息有 20K token 保真预算 |
| 微压缩 | 不改写语义的前提下先做轻量回收，尽量推迟全量摘要 |

**为什么不是「全部塞进去」**：工具输出无界增长会让模型在真正需要推理时已经没有窗口。宁可丢旧细节，也不让上下文无界膨胀。

> token 估算是启发式的（provider 没有可靠 tokenizer 时），文档与输出一律标注 approximate，不假装精确。

---

## 2. 重试（Retry）

重试发生在 provider 层（`src/provider/retry.ts`），且**只对明确可重试的失败**退避重试：

- `EmptyResponseError` —— 空响应
- `StreamIdleTimeoutError` —— 流空闲超时
- `MaxTokensExhaustedError` —— 输出被 `max_tokens` 截断

指数退避 + 可重试判定。**不可重试的错误（如参数非法）不会重试**——把不可恢复的错误也重试，只会把失败拖长并把噪音灌进上下文。

---

## 3. 恢复（Recovery）

恢复是「失败后怎么走下一步」，不是「原 prompt 再跑一次」。

Agent 循环内置（`src/agent/loop.ts`）：

- **`maxIterations`**（默认 500）—— 硬上限，防无限循环
- **分档轮次告警** —— 到中段（mid）与后段（late）时给模型显式提示「已进行 N 轮 / 上限 M」，让它有机会收敛
- **`noProgress` 检测** —— 识别「还在调用工具但没有推进」并终止
- **并行工具调度** —— 冲突判定、乱序执行、按序回收

工具失败时回给模型的是**结构化错误反馈**（工具名、参数、失败原因），由模型决定：重试 / 改参数 / 换工具 / 停止。

---

## 4. 验证（Verification）

**不允许仅凭模型说「Done.」。**

两条路径：

1. **`postGreen`（`src/agent/postGreen.ts`）** —— 当一轮工具结果里出现完整测试套件的全绿时，可提前终止本轮。默认关闭（opt-in），因为它是一个实验性干预。
2. **Mission verifier（`step mission verify`）** —— 独立控制面：执行 manifest 里登记的 `acceptance` 命令、比对退出码、写证据包。`completed` **只能**由 `verification.completed(passed=true)` 触发，模型自报完成不算完成。

关键不变量 —— **harness 故障 ≠ 断言失败**：

命令非零退出且输出命中环境故障特征（`No test files found`、`Cannot find module`、`command not found`…）时，判定为「环境坏了」而不是「断言没过」，Mission 退回 `running` 并显式标记，**绝不**据此置 `completed` / `failed`。

否则一个框架 bug 会被读成「模型没做对」——这正是本项目 benchmark 审计里 D1 缺陷的教训。

---

## 5. 轨迹（Traces）

每一次 run 都落结构化事件：

- **会话事实源**：`~/.step-pilot/.../<session>.wire.jsonl`，只追加，事件即真相
- **任务事实源**：Mission 事件单独落在 `missions/<repo 桶>/<missionId>.events.jsonl`，**不写进会话 wire**（生命周期不同，混写会污染会话恢复）

事件覆盖：`thinking_start/end`、`tool_start` / `tool_end`（含 `isError`、`duration`）、`usage`、`text`、`turn_done`、`result`。

非交互模式可直接输出 `stream-json`，供 CI 与外部分析消费。benchmark harness 复用同一套事件产出结果 JSON，因此**产品运行与研究测量共用一份真相**。

---

## 一个真实运行（不是示意）

任务 `cascading-fix-001`：仓库里埋了 3 个互相独立的 bug，每次跑测试才会暴露下一个。

模型 **step-3.7-flash**，provider **stepfun**，2026-09-18 实跑：

```
list_dir ×2  →  read_file ×5
[8]  edit_file                     修 JSON parser
[9]  bash  npx vitest run          ✗  ✓ parses json | × filters active | × formats output   (1/3)
[10] edit_file                     修 active filter
[11] bash  npx vitest run          ✗  ✓ parses | ✓ filters active | × formats output        (2/3)
[12] edit_file                     修 HTML formatter
[13] bash  npx vitest run          ✓  src/cascade.test.ts (3 tests)  Tests 3 passed (3)     (3/3)
```

| 指标 | 实测 |
|------|------|
| 结果 | 成功（验证 1 passed / 0 failed） |
| 轮次 | 10 |
| 工具调用 | 13 |
| 工具错误（已恢复） | 2 |
| 重试 | 0 |
| 压缩次数 | 0 |
| 耗时 | 42.2s |

**注意**：这里**没有**列 token 数。Step 三协议的 `reasoning_tokens` 恒为 0、思考消耗不可观测，本次 run 上报的 `input / output / total` 三个数彼此矛盾。按本项目纪律，拿不到可靠数字就**不发布**，不做估算充数。

原始结果：`benchmark/results/demo-cascading-fix.json`。

---

## 诚实性边界（贯穿全部）

1. **历史 benchmark 结果不可引用**：`benchmark/results/` 下的历史数字混着框架缺陷期（D1：误删测试文件导致 verify 恒失败）的样本，**不是模型能力**。任何对外的能力数字必须来自重新实跑。
2. **不虚构 token / 延迟**：只写 provider 可靠返回的字段。
3. **不夸大**：不宣称「修复了 N 个上游 bug」、不公布覆盖率百分比、不做成本/省钱叙事。本页所有机制描述都对应 `src/` 里真实存在的模块。
