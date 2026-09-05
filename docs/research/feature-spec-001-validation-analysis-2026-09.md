# feature-spec-001：validation-loop 与 wall-clock 研究（2026-09，Step ①–④）

> 研究问题：在相同模型、相同任务、相同环境下，agent 的 300s timeout 与哪些可观测行为相关？
>
> 研究对象：`benchmark/tasks/feature/feature-spec-001`——6 文件、12 行为测试的 context-heavy / long-horizon 任务（buggy 12/12 FAIL，golden 12/12 PASS）。
> 模型：step-3.7-flash（stepfun-plan 渠道）。timeout = 300s。
>
> 状态：**Step ①②③④ 已封口，Step ⑤（intervention experiment）未开始。**
> 全部结论为 observational association，无 causal claim。

## Evidence 文件

| 文件 | 说明 |
|---|---|
| `benchmark/results/ab-{A1..B5}.json` | sealed baseline：A/B 交错 10 runs（v3 事件流，无时间戳） |
| `benchmark/results/v4-{A1..B5}.json` | Step ④ 受控实验：10 runs（v4 instrumented，含 ts/mono/turn） |

## Step ① — validation-loop post-hoc analysis

指标（`benchmark/analysis/validationMetrics.ts`，25 tests）：
`regression_count` / `max_validation_gap` / `final_validation_gap` / `monotonicity` / `rewrite_ratio` / suite `total` mutation 检测。仅在全量 suite checkpoint（`vitest run` 后无路径、无 `-t` 过滤）间计算 F 口径。

**固化脚本修正了最初人工分析的三处解析伪影**（`Test Files` 文件级行污染 F、`(12)` 误配 `-t` 过滤跑的 `11 skipped (12)`、head/tail 截断漏检）：

- B3 的「regression cycling」指纹作废——真指纹是 **flatline**（8 个全量 checkpoint 全部 10F，49 turns 58 次写零进展）。
- B5 regression → 0，纯 **verification abandonment**（1F/11P 后零验证）。
- B1 是 **debugging drift**（regression=0 但 28-turn 退出全量验证）。
- `rewrite_ratio` 不判别结局（B4 0.91 却成功）——negative finding，不得作 intervention target。
- `max_validation_gap` 是 risk signal 非 threshold：B1=28 vs B2=27 结局相反。

## Step ② — stream-json v4 timestamp instrumentation

`src/session/streamJson.ts`（协议 v3→4）+ `src/cli.ts`（5 个发射点）。observationally neutral：仅 emission 层标注，事件触发时机/内容/顺序零变化。

| 字段 | 时钟 | 用途 |
|---|---|---|
| `ts` | `Date.now()` epoch ms（非单调） | 绝对时间对齐 |
| `mono` | `performance.now()` ms（单调） | **一切 duration 计算的主时钟** |
| `turn` | `thinking_start` 计数（1-based，0=首轮前） | 轮次归属，与后验口径逐字一致 |

## Step ③ — wall-clock decomposition

`benchmark/analysis/wallClock.ts`（15 tests）。归因状态机（真实事件流核实）：`usage` 是**轮末标记**而非 model 调用结束（tool 执行夹在模型流末与 usage 之间）；`retry` 恒紧邻下一轮 `thinking_start`。

```
STREAM 连续段                          => model
tool_start→tool_end（含 vitest run）    => test（否则 tool）
retry → 下一 STREAM 事件                => wait
其余（轮间开销/TTFB/teardown）          => other（残差，不强行归满，报 coverage）
```

全部 duration 用 `mono`；类别总量按类内窗口并集（并行工具重叠不双计）；mono 非单调必须上报，不静默修正。

**硬限制**：ab-* baseline 为 v3（零时间字段），逐事件分解对其物理不可行（decomposeCli 报 no-timing-data）；真实分解由 Step ④ 的 v4 runs 落地。

## Step ④ — controlled v4 experiment

Preflight：baseline 后 src 变更仅步骤② 两个 instrumentation 文件；task/verifier/runner/timeout 全部未动。10 runs（A/B 交错 5+5，sealed 同 protocol），**完整性 100%**：ts/mono/turn 全覆盖、mono 零违反、turn 零违反、tool 配对零悬空、anomalies=0。

### 结果（mono 口径，agent 纯耗时）

| Run | Outcome | Total | Model | Tool | Test | Other | Coverage |
|---|---|---:|---:|---:|---:|---:|---:|
| A1 | TIMEOUT | 295.9s | 188.7s (63.8%) | 6.3s | 29.6s | 71.3s | 75.9% |
| B1 | TIMEOUT | 297.5s | 211.4s (71.1%) | 12.2s | 23.8s | 50.2s | 83.1% |
| A2 | SUCCESS | 147.0s | 118.9s (80.9%) | 0.2s | 9.0s | 18.9s | 87.1% |
| B2 | CENSORED(451) | 185.7s | 109.7s (59.1%) | 14.9s | 18.7s | 42.4s | 77.2% |
| A3 | SUCCESS | 181.9s | 137.5s (75.6%) | 14.4s | 6.4s | 23.6s | 87.0% |
| B3 | SUCCESS | 257.9s | 149.7s (58.1%) | 0.6s | 28.4s | 79.1s | 69.3% |
| A4 | TIMEOUT | 297.3s | 250.6s (84.3%) | 0.3s | 8.9s | 36.2s | 87.8% |
| B4 | SUCCESS | 134.4s | 100.3s (74.6%) | ~0 | 9.2s | 25.0s | 81.4% |
| A5 | TIMEOUT | 296.4s | 205.1s (69.2%) | 1.3s | 25.6s | 63.2s | 78.7% |
| B5 | TIMEOUT | 296.3s | 213.9s (72.2%) | 0.6s | 24.0s | 57.8s | 80.5% |

- `other` 的 94–96% 是 `usage→thinking_start` 轮间开销（1.0–1.9s/turn，含下一次 model 调用的首 token 延迟）——真实 model 相关时间比表中更高。
- 单次 vitest 全量执行恒 2.2–2.5s；test 总耗时 6–30s（3–11%）。**验证执行本身在墙钟上极其便宜。**
- composition 不分离结局（成功组与超时组的 model/tool/test/other 占比重叠）。

### Failure-mode 描述性分类

- **debugging drift**（A1）：46-turn 验证断档（bash 密集 debug），重入后读出 1F，被杀时距完成 1 个测试。
- **validation flatline**（A5、B5、B1）：验证节奏正常、连续 4–6 个 checkpoint 停在 10F。
- **verification abandonment**：本样本未出现（所有 timeout run 的 fvg ≤ 4，都在持续验证到被杀）。
- **关键案例 A4**：**T30 已达 0F@12（12/12 全绿），之后 ~5.6s 在写总结文本时被 300s 到点杀死**——工程完成、会话未收尾。若 0F 即停，A4 = SUCCESS。

### Candidate-signal assessment

| 信号 | 评估 |
|---|---|
| `final_validation_gap` | **contradicted**（未复现 sealed 分离：timeout {1,4,2,1,2} vs success {1,2,1,2}） |
| `max_validation_gap` | weak association（A1=46 极端；B3 成功 15 > B1 超时 11；不可作 threshold） |
| `stagnation` | weak association + 反例（timeout 链均 4.0 vs success 2.25；B3 以 4×10F 链成功） |
| `suite mutation` | **contradicted**（唯一 mutation 出现在成功 run B3：12t→13t→12t） |

### 反例清单

同 fvg=2 的 A4（TIMEOUT、已 0F）vs B4（SUCCESS）；composition 相近结局相反（A2 80.9% vs A4 84.3%）；test 成本最高的 B3（28.4s）成功；验证最频繁的 B1/A5 超时；绝对 model 时间更高不能解释 timeout——model 主导下「跑得久 ⇒ model 时间多」是结果非原因（循环论证，明确排除）。

### 因果边界

observed（§时间结构）→ associated（stagnation 弱关联、drift 个案）→ supported hypothesis（「0F 即停」可挽回 A4 类；300s 硬约束在 model 流式时间而非验证执行）→ **causal conclusion：无**。

### 候选 intervention（仅记录，未实施）

1. **post-green termination**：全量 0F 后立即终止（A4 直接证据）。
2. **drift guard**：max_validation_gap 软提示（反例风险：B3）。
3. **stagnation breaker**：连续同 F 注入换向提示（反例风险：B3/A2）。

## 复现

```bash
pnpm benchmark run --task feature-spec-001 --profile full|ablation --runs 1 --output <path>
npx tsx benchmark/analysis/cli.ts <result.json>          # validation-loop 指标
npx tsx benchmark/analysis/decomposeCli.ts <result.json> # wall-clock 分解
```

测试：`npx vitest run tests/analysis/ tests/session/streamJson.test.ts tests/session/streamJsonInstrument.test.ts`（79 tests）。
