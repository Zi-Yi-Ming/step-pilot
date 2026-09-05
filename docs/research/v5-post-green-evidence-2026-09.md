# Step⑤ — Post-Green Termination Experiment（v5 Evidence Report）

> **Implementation checkpoint:** `e9f0466`（feat: add post-green termination intervention）
> **Experiment:** v5 controlled experiment（2026-09-05）
> **Design:** 5 Control（flag OFF）+ 5 Treatment（flag ON），A→B 交错
> **Status:** descriptive evidence only — no causal claim, no statistical significance claim
> **Raw evidence:** `benchmark/results/v5-{A1..B5}.json`（机器生成，未手工编辑）

## 1. Research Question

基于 Step④ 的观察（A4 在 0F@12 后仅 ~5.6s 收尾文本即被 300s timeout 杀死），检验一个最小 intervention——**post-green termination**（全量测试套件明确全绿后尽快结束 session）——是否能改善 session termination / validation-loop behavior。

## 2. Intervention Definition

`[agent] post_green_termination`（默认 false）。开启时：本 run 内某批工具结果中出现**完整 vitest suite 全绿**（`npx vitest run` 无过滤、`failed === 0 && passed > 0`、suite 总数不小于本 run 此前任何全量 checkpoint——suite 不收缩守卫）→ 当前回合收尾时提前终止，走既有 result-success 下游语义。检测口径逐条镜像 Step①③ 封板解析规则（`src/agent/postGreen.ts`）。

## 3. Experimental Design

- Control = flag OFF（ablation profile，v4-A 同款 compaction 配置）；Treatment = flag ON（full profile，v4-B 同款 compaction 配置 + flag）。
- 唯一变量 = flag；task / prompt / model / provider / verifier / harness / timeout=300s / 交错序（A1→B1→…→A5→B5）全部与 Step④ 协议一致。
- 每 run 前后 config md5 校验（零泄漏）；结果文件逐 run 新建。
- 运行时代码 = `e9f0466` index 隔离构建（checkout-index → 隔离 build → 部署 dist）。

## 4. Immutable Implementation Checkpoint

```text
e9f0466 feat: add post-green termination intervention
```

实验全程 HEAD 未变；实验后 `git diff e9f0466 -- benchmark/results/` 为空。

## 5. Raw v5 Run Table

| Run | Group | Outcome | Duration(s) | Turns | Tools | Events | Verifier | MVG | FVG | Stag | Suite Mut | Green State | Suite Total | Trigger | Trigger Turn | Green Time(s) | Timeout Margin(s) | Model(s) | Tool(s) | Test(s) | Other(s) | Coverage% |
|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A1 | Control | VERIFIER-FAIL | 14 | 4 | 14 | 308 | FAIL | 4 | 4 | 0 | 0 | not reached | N/A | N/A | N/A | N/A | N/A | 7 | 0 | 0 | 3 | 68.9 |
| B1 | Treatment | VERIFIER-FAIL | 285 | 37 | 46 | 9,892 | FAIL | 14 | 0 | 2 | 3 | reached（13/13） | 13 | **yes** | 37/37 | 281.5 | 18.5 | 215 | 1 | 22 | 42 | 85.0 |
| A2 | Control | TIMEOUT | 301 | 45 | 58 | 9,522 | not-run | 30 | 1 | 2 | 1 | not reached（1F@15t） | 15 | N/A | N/A | N/A | N/A | 223 | 1 | 22 | 51 | 82.8 |
| B2 | Treatment | SUCCESS | 144 | 26 | 38 | 3,784 | pass | 14 | 0 | 2 | 2 | reached（12/12） | 12 | **yes** | 26/26 | 140.6 | 159.4 | 104 | 0 | 9 | 26 | 81.2 |
| A3 | Control | TIMEOUT | 301 | 38 | 48 | 9,949 | not-run | 18 | 1 | 2 | 2 | reached（0F@12） | 12 | N/A（Control） | N/A | ~turn 37 | N/A | 221 | 4 | 28 | 45 | 85.0 |
| B3 | Treatment | SUCCESS | 282 | 54 | 63 | 7,418 | pass | 21 | 0 | 4 | 2 | reached（12/12） | 12 | **yes** | 54/54 | 278.4 | 21.6 | 182 | 4 | 31 | 62 | 77.8 |
| A4 | Control | TIMEOUT | 301 | 48 | 64 | 9,152 | not-run | 41 | 6 | 1 | 1 | not reached | 12 | N/A | N/A | N/A | N/A | 197 | 4 | 38 | 59 | 80.2 |
| B4 | Treatment | SUCCESS | 155 | 13 | 21 | 6,588 | pass | 10 | 0 | 1 | 0 | reached（12/12） | 12 | **yes** | 13/13 | 150.7 | 149.3 | 132 | 0 | 4 | 14 | 90.5 |
| A5 | Control | SUCCESS | 179 | 27 | 44 | 4,555 | pass | 8 | 1 | 1 | 3 | reached（12/12） | 12→15→12 | N/A（Control） | N/A | N/A | N/A | 126 | 0 | 21 | 28 | 84.0 |
| B5 | Treatment | SUCCESS | 299 | 29 | 45 | 10,905 | pass | 6 | 0 | 4 | 0 | reached（12/12） | 12 | **yes** | 29/29 | 295.4 | 4.6 | 222 | 2 | 20 | 51 | 82.7 |

MVG = max validation gap（turns）；FVG = final validation gap（turns）；Stag = 最长连续同 F 同 total 全量 checkpoint 链；Suite Mut = 相邻 checkpoint total 变化次数；Green Time = 全绿判定时刻（run 起点起算）；Timeout Margin = 300s − Green Time。instrumentation：10/10 runs `timed = events`、mono 零违反、turn 零违反、tool 配对零悬空、anomalies = 0。

## 6. Intervention Mechanism

Observed（Treatment）：

```text
5/5 triggered
5/5 turnsAfterGreen = 0
5/5 measured latency = 0.0s（事件级立即终止；测量分辨率为事件流粒度，非物理零时间）
```

Control：intervention disabled（flag OFF——按协议记录为「功能关闭」，与「功能存在但未触发」区分）。

Mechanism 与 Outcome 分开陈述：**The intervention mechanism triggered in all five Treatment runs; four of those runs ultimately passed verification.**

## 7. Control vs Treatment Outcomes

```text
Control（n=5）:   success 1/5 | timeout 3/5 | verifier-fail 1/5 | censored 0
Treatment（n=5）: success 4/5 | timeout 0/5 | verifier-fail 1/5 | censored 0

observed success rate: 20% → 80%
observed timeout rate: 60% → 0%
（n=5 per group；descriptive comparison only）
```

## 8. Case Analysis

### A1 — Model Path Error
模型连续 3 次以错误路径（`src/__tests__/audit.ts` 等）read_file → 重试循环守卫早停（4 turns）→ verifier 在未修复 repo 上 FAIL。model-side wrong-path behavior caused repeated read_file failures and retry-loop early termination, followed by verifier failure. Not intervention-related。

### B1 — Growth-at-Green False Positive
```text
12 → 13 tests
↓
13/13 green
↓
termination criterion satisfied
↓
termination
↓
verifier expects 12 passed
↓
VERIFIER-FAIL
```
This is an observed instance of the pre-registered growth-at-green residual risk. It is not classified as an implementation bug: the implementation followed the predefined task-agnostic criterion and the verifier independently enforced the benchmark contract. Margin 18.5s 下自然收尾也会到达 verifier 并以同样原因 FAIL——outcome 等价、更快。

### A2 — Near-Green Timeout
末次 checkpoint 1F@15t（suite 膨胀后差 1 个测试）超时。Green 从未达成——intervention 定义上不适用。说明干预不是「所有 timeout 都能解决」的通用机制。

### B2 — Early Green
green@140.6s、余量 159.4s。likely non-critical：自然行为大概率同样成功；干预消除收尾轮（秒级）。

### A3 — Green-Then-Timeout
T37 达 0F@12 → 又继续 1 回合 → 301s 超时。**control-side target-compatible counterexample**：若为 Treatment，应在 T37 终止。其 treatment counterfactual was not directly observed。

### B3 — Marginal Green
green@278.4s、余量 21.6s。marginal：自然收尾（参照 A4 epilogue ~5.6s）可能赶上也可能不；observed 为干预下 SUCCESS。

### A4 — Drift Timeout
从未达绿（末次 10F@0 横幅）、mvg=41（本实验最大 drift 断档）。与 Step④ A4 的「green 后写总结被杀」**不同型**——v5 的 A4 是「无绿可触发」的 drift。

### B4 — Early Green
green@150.7s、余量 149.3s、13 turns（全实验最少）。likely non-critical。

### A5 — Control Success
Control 组自然成功（含 suite mutation 12→15→12）。intervention not necessary。

### B5 — Strongest Rescue-Compatible Case
green@295.4s、距 timeout 边界仅 4.6s、立即终止、total 299.0s、verifier pass。The counterfactual continuation of B5 without intervention was not observed；参照 A4 epilogue ~5.6s，自然行为极可能超时——但这是 mechanistically suggestive，不是直接观测的反事实。

## 9. Wall-Clock Analysis

Control：model 126–223s、tool 0–4s、test 21–38s、wait 0、other 28–59s、coverage 68.9–85.0%。
Treatment：model 104–222s、tool 0–1s、test 4–31s、wait 0–1s、other 14–62s、coverage 77.8–90.5%。
两组 composition 重叠、model 主导结构与 Step④ 一致。专项确认：B5 green@295.4s、margin 4.6s、total 299.0s SUCCESS；A3 green at T37/38，之后 1 回合 + 超时。

## 10. Historical v4 Reference

v4 = historical reference（pre-intervention baseline，10 runs：A 2/5、B 3/5 成功，timeout 6/10，A4 达 0F 后 ~5.6s 被杀）。v4 不是 v5 Control；不计算 v4→treatment effect。三组身份：v4 = historical reference；v5 Control = fresh experimental control；v5 Treatment = fresh experimental treatment。

## 11. Residual Risks

1. **growth-at-green false positive**（B1 实证：13t 绿 → verifier 12-passed FAIL）。
2. `vitest run --reporter verbose`（空格形态）safe false-negative——runtime 与封板 analysis 口径一致地更严格。
3. suite growth 与 task-specific verifier size-mismatch（与 1 同源，无 task-agnostic 修复，不引入 `passed === 12` 类 magic number）。
4. 小样本（n=5/组）+ 单任务 + 单模型 + stochastic agent behavior。

## 12. Threats to Validity

n=5 per group；single benchmark task；single model；stochastic agent behavior；Control A1 model-side early termination；B1 growth-at-green FP；suite-growth / verifier contract mismatch；`--reporter verbose` safe false-negative；no direct counterfactual observation（A3/A4/B5 的反事实均未观测）；v4 与 v5 不是可互换的实验组。

## 13. What the Experiment Establishes

- 干预机制在全部 5 个 Treatment run 中按定义检测并立即终止（0 额外回合）。
- 本 5+5 样本中，Treatment 的 observed timeouts（0 vs 3）与 observed successes（4 vs 1）均优于 Control。
- 预登记的 growth-at-green residual risk 在真实运行中发生并被 verifier 捕获（干预无法伪造成功）。

## 14. What the Experiment Does Not Establish

No causal effect, statistical significance, or population-level generalization is established by this experiment. 未证明所有 post-green timeout 都会被挽回；未证明 intervention 提升代码质量（唯一质量门是 verifier）；未建立 A3/B5 的直接反事实。

## 15. Research Conclusion

The experiment provides descriptive evidence consistent with the intended mechanism: once the predefined full-suite green condition was reached, the intervention terminated the session immediately rather than allowing further agent turns. In this 5+5 sample, Treatment exhibited fewer observed timeouts and more observed successful terminal outcomes than Control. B1 confirms the pre-registered growth-at-green residual risk; B5 is the strongest observed rescue-compatible case; A3 is the strongest control-side target-compatible case. Follow-up（若继续）应扩大样本并直接观测自然收尾时间分布，以校准 epilogue 成本假设。

## Provenance

```text
Implementation checkpoint: e9f0466
Experiment result files:   v5-A1.json ... v5-B5.json（SHA-256 manifest 见下）
Historical evidence:       ab-A1..B5.json / v4-A1..B5.json
Analysis basis:            Step① validationMetrics.ts / Step③ wallClock.ts（封口，未改动）
```

SHA-256（v5 raw evidence，报告生成时点）：

```text
25fae4a2… v5-A1.json  114beaed… v5-A2.json  d1f381e8… v5-A3.json
713e29ee… v5-A4.json  561f415c… v5-A5.json  b017d504… v5-B1.json
b20c028c… v5-B2.json  ae24473d… v5-B3.json  9b96ee5f… v5-B4.json
38ae6f69… v5-B5.json
```
