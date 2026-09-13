# Small-Model Reliability Benchmark

> 回答一个具体问题：
> 「在相同模型、相同任务、相同环境下，step-pilot 相比 baseline，是否真的提高了 coding task 的成功率和可靠性？」

---

## Quick Start

```bash
# 列出所有 tasks
pnpm benchmark list

# 跑全部 tasks（默认 3 runs）
pnpm benchmark run

# 跑单个 task
pnpm benchmark run --task single-file-bug-001

# 指定 profile
pnpm benchmark run --profile ablation

# 指定 runs
pnpm benchmark run --runs 5

# 生成单次报告
pnpm benchmark report --input benchmark/results/<timestamp>.json

# 可靠性仪表盘：跨全部结果文件聚合出四条头条指标
pnpm benchmark dashboard

# 仪表盘 + 落盘 JSON + 输出徽章 URL
pnpm benchmark dashboard --out benchmark/dashboard.json --badge

# 只扫描指定目录
pnpm benchmark dashboard --dir benchmark/results
```

---

## Task 分类

| Group | Category | 数量 | 说明 |
|-------|----------|------|------|
| A | single-file-bug-fix | 5 | 单文件 bug 修复 |
| B | multi-file-bug-fix | 5 | 跨文件 bug 修复 |
| C | tool-heavy-exploration | 4 | 大量工具调用的探索任务 |
| D | long-horizon | 4 | 多回合长任务 |
| E | mcp | 2 | 使用 MCP 工具的任务 |

---

## Baseline

当前使用 **ablation baseline**：

| Profile | 说明 |
|---------|------|
| `full` | 完整 step-pilot reliability 优化 |
| `ablation` | 关闭 reliability 优化（更高 compaction 阈值、关闭 tool preprocessing、关闭 auto-disable） |

未来可扩展为与其他 agent 对比。

---

## Success 判定

Task 成功当且仅当：
1. 所有 `verify` checks 全部通过（文件包含/不包含、测试通过、命令执行成功）
2. `max_turns` 未超限
3. `timeout` 内完成

**不用模型自述判断成功**，只用 machine-checkable 的 checks。

---

## 输出

- JSON 结果：`benchmark/results/<timestamp>.json`
- Markdown 报告：终端直接输出
- 仪表盘 JSON：`pnpm benchmark dashboard --out <path>`

---

## 可靠性仪表盘

`benchmark/dashboard.ts` 把散落的单次结果聚合成四条**头条指标**，并额外列出两条**评测可信度指标**——这是「可靠性是本项目
唯一对外卖点」的量化底座（没有它，所有修复都只是「我觉得更好了」）：

| 指标 | 为什么单列 |
|------|-----------|
| 成功率 | 主指标 |
| 平均 token | 上下文经济性的观测口 |
| 空响应率 | Step 三协议 `reasoning_tokens` 恒为 0，思考耗尽预算导致的空响应是本项目最典型的**不报错故障**，必须可见 |
| 工具泄漏率 | 模型把工具调用打成纯文本、工具从未执行——不单列就永远发现不了 |
| 框架故障率 | verify 命令本身因环境问题没跑起来——不单列会把评测 bug 误读成模型失败 |
| 未执行验证率 | agent 未发出成功终态，verify 被跳过——与框架故障不同，单列避免把超时伪装成环境坏 |

设计与边界：

- **纯函数 + 单点 IO**：`aggregateRuns()` / `buildDashboard()` 不碰文件系统（好测），
  `loadRunFiles()` 是唯一读盘入口。
- **判据有明确理由**：空响应不用「输出 token 少于 N」这类阈值判（合法短答——问 1+1 答 2
  ——输出天然极少，区分它需要任务复杂度，客户端拿不到）；工具泄漏只匹配**尖括号标签形态**，
  不匹配裸词（裸词字面就写在本仓与设计文档里，agent 复述文档会触发误报）。
- **不声称因果**：只输出描述性统计，不写「提升了 X%」——那需要对照组才成立。
- **评测故障不洗白**：`harness_broken` 只统计 verify 命令本身因环境问题无法执行；
  agent 未成功、导致 verify 没跑的情况单列为 `verification_skipped`，不把模型失败伪装成环境坏。

回归测试：`tests/analysis/dashboard.test.ts`（30 用例，重心是两条判据与评测可信度口径）、
`tests/analysis/harnessFailure.test.ts`（14 用例，框架故障判据双向变异验证）。

---

## 架构

- **不污染核心 runtime**：只消费 `stream-json` 输出
- **复用现有 telemetry**：`model.usage`、`tool_start`/`tool_end`、`retry`、`context.apply_compaction`、`turn.issue`、`mcp.tool_call`
- **轻量 runner**：spawn step-pilot `-p --output-format stream-json`，解析 stdout
