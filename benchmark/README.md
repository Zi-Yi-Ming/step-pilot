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

# 生成报告
pnpm benchmark report --input benchmark/results/<timestamp>.json
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

---

## 架构

- **不污染核心 runtime**：只消费 `stream-json` 输出
- **复用现有 telemetry**：`model.usage`、`tool_start`/`tool_end`、`retry`、`context.apply_compaction`、`turn.issue`、`mcp.tool_call`
- **轻量 runner**：spawn step-pilot `-p --output-format stream-json`，解析 stdout
