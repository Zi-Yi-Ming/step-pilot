# Small-Model Reliability Benchmark — Design

> 本文档是 step-pilot benchmark 的架构设计，用于回答：
> 「在相同模型、相同任务、相同环境下，step-pilot 相比 baseline，是否真的提高了 coding task 的成功率和可靠性？」

---

## 1. 设计原则

1. **不污染核心 runtime**：benchmark 只消费现有 `stream-json` 输出，不改动 `src/agent`、`src/loop` 等核心路径。
2. **复用好 telemetry**：`model.usage`、`tool_start`/`tool_end`、`retry`、`context.apply_compaction`、`turn.issue`、`mcp.tool_call` 已足够支撑 benchmark 指标。
3. **Baseline 优先走 ablation**：不硬编码第二个 agent，而是复用 step-pilot 自身，关闭/恢复特定 reliability 优化做 ablation。
4. **Task 少而精**：第一版 20 tasks，不追求数量，追求可复现、machine-checkable。
5. **Success 必须 machine-checkable**：不用模型自述，用文件/测试/命令断言。

---

## 2. 可复用数据面（Phase 1 结论）

step-pilot 的 `-p --output-format stream-json` 已经暴露足够信息：

| 事件 | 来源 | Benchmark 用途 |
|------|------|----------------|
| `text` | agent loop | 最终输出文本（用于日志，不用于 success 判定） |
| `tool_start` | agent loop | 工具调用计数 |
| `tool_end` | agent loop | 工具成功率 / 错误率 |
| `retry` | runTurn | 重试次数 |
| `thinking_downgrade` | runTurn | 思考档位降级次数 |
| `thinking_recover` | runTurn | think-only 恢复次数 |
| `thinking_loop` | runTurn | 思考死循环次数 |
| `usage` | loop / runTurn | 每轮 token 消耗 |
| `model.usage` (wire) | wirelog | 真实服务端 usage（input/cache/output） |
| `context.apply_compaction` | wirelog | 压缩发生次数 |
| `turn.issue` | wirelog | 空响应 / 重试 / 错误审计 |
| `mcp.tool_call` (wire) | wirelog | MCP 工具调用统计 |
| `result` | streamJson | 终态成功/失败 |
| `error` | streamJson | 错误信息 |

**不需要新增任何 runtime 事件**。

---

## 3. Task Schema

```yaml
id: single-file-bug-001
category: single-file-bug-fix
difficulty: easy
description: "Fix the off-by-one error in the loop boundary"
repository: benchmark/fixtures/repo-a
setup: |
  # 创建包含 bug 的仓库
  git init repo && cd repo
  cat > src/utils.ts << 'EOF'
  export function sum(values: number[]): number {
    let total = 0;
    for (let i = 0; i <= values.length; i++) {  // bug: <= should be <
      total += values[i];
    }
    return total;
  }
  EOF
verify:
  - type: test
    command: cd repo && npx vitest run
    expect:
      exit_code: 0
  - type: file_contains
    path: repo/src/utils.ts
    pattern: "for (let i = 0; i < values.length; i++)"
  - type: file_not_contains
    path: repo/src/utils.ts
    pattern: "for (let i = 0; i <= values.length; i++)"
success_criteria:
  tests_pass: true
  files_modified: ["src/utils.ts"]
  max_turns: 10
timeout: 120
metadata:
  tags: [loop, off-by-one, typescript]
```

### Task 分类

| Group | Category | 数量 | 说明 |
|-------|----------|------|------|
| A | single-file-bug-fix | 5 | 单文件 bug 修复 |
| B | multi-file-bug-fix | 5 | 跨文件 bug 修复 |
| C | tool-heavy-exploration | 4 | 大量工具调用的探索任务 |
| D | long-horizon | 4 | 多回合长任务 |
| E | mcp | 2 | 使用 MCP 工具的任务 |

---

## 4. Check System

### Check 类型

```yaml
checks:
  - type: test
    command: "cd repo && npx vitest run"
    expect:
      exit_code: 0
      stdout_contains: "Tests 1 passed"
      stderr_not_contains: "FAIL"

  - type: command
    command: "cd repo && node -e 'console.log(require(\"./src/utils\").sum([1,2,3]))'"
    expect:
      exit_code: 0
      stdout_contains: "6"

  - type: file_exists
    path: repo/src/utils.ts

  - type: file_contains
    path: repo/src/utils.ts
    pattern: "for (let i = 0; i < values.length; i++)"

  - type: file_not_contains
    path: repo/src/utils.ts
    pattern: "for (let i = 0; i <= values.length; i++)"

  - type: git_diff
    path: repo
    expect:
      files_modified: ["src/utils.ts"]
      files_not_modified: ["package.json"]

  - type: custom
    command: "node checks/verify-fix.js"
```

### Success 判定

Task 成功当且仅当：
1. 所有 `checks` 全部通过
2. `max_turns` 未超限
3. `timeout` 内完成

任何一条不满足 = 失败。

---

## 5. Baseline 定义

### Primary Baseline：Ablation Profile

不跑第二个 agent，而是跑同一个 step-pilot 二进制，但关闭/恢复特定 reliability 优化。

```yaml
profiles:
  full:
    name: "step-pilot full"
    description: "完整 reliability 优化"
    config:
      compaction:
        trigger_ratio: 0.75
        user_message_max_tokens: 20000
      tools:
        preprocess: true
      retry:
        auto_disable: true
      prompt:
        trimmed: true

  ablation:
    name: "step-pilot ablation"
    description: "关闭 reliability 优化"
    config:
      compaction:
        trigger_ratio: 0.95
        user_message_max_tokens: 5000
      tools:
        preprocess: false
      retry:
        auto_disable: false
      prompt:
        trimmed: false
```

### 对比矩阵

| Profile | 说明 |
|---------|------|
| `full` | 完整 step-pilot |
| `ablation` | 关闭 reliability 优化 |
| `baseline` | 预留：未来接入其他 agent |

---

## 6. Result Schema

```json
{
  "benchmark_version": "0.1.0",
  "timestamp": "2026-09-04T12:00:00Z",
  "task_id": "single-file-bug-001",
  "category": "single-file-bug-fix",
  "profile": "full",
  "model": "step-3.7-flash",
  "provider": "stepfun",
  "step_pilot_commit": "0c1eeab",
  "run_index": 1,
  "success": true,
  "duration_ms": 45230,
  "turns": 4,
  "tool_calls": 7,
  "tool_errors": 0,
  "retries": 0,
  "compactions": 0,
  "input_tokens": 125000,
  "output_tokens": 3400,
  "total_tokens": 128400,
  "stop_reason": "end_turn",
  "failure_reason": null,
  "checks_passed": 3,
  "checks_failed": 0,
  "events": []
}
```

### 聚合统计

```json
{
  "summary": {
    "task_id": "single-file-bug-001",
    "runs": 3,
    "success_rate": 1.0,
    "mean_duration_ms": 43800,
    "median_duration_ms": 45230,
    "mean_turns": 3.7,
    "mean_tool_calls": 6.3,
    "mean_tool_errors": 0.3,
    "mean_retries": 0.0,
    "mean_compactions": 0.3,
    "mean_total_tokens": 126000,
    "failure_taxonomy": {
      "tool_call": 0,
      "context": 0,
      "compaction": 0,
      "loop": 0,
      "environment": 0,
      "test_failure": 0,
      "timeout": 0,
      "model": 0,
      "other": 0
    }
  }
}
```

---

## 7. 目录结构

```
benchmark/
├── README.md
├── package.json
├── runner.ts
├── reporter.ts
├── tasks/
│   ├── single-file-bug/
│   │   ├── 001-off-by-one/
│   │   │   ├── task.yaml
│   │   │   ├── setup.sh
│   │   │   ├── verify.sh
│   │   │   └── checks/
│   │   │       └── verify.js
│   │   └── ...
│   ├── multi-file-bug/
│   ├── tool-heavy/
│   ├── long-horizon/
│   └── mcp/
├── profiles/
│   ├── full.yaml
│   └── ablation.yaml
└── results/
    └── 2026-09-04T120000Z.json
```

---

## 8. CLI

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
pnpm benchmark report --input results/2026-09-04T120000Z.json

# 对比报告
pnpm benchmark report --compare results/a.json results/b.json
```

---

## 9. 与核心 Runtime 的隔离

- **不修改** `src/agent/`、`src/provider/`、`src/loop.ts`
- **不新增** runtime 事件
- **只消费** `stream-json` stdout
- **只通过** `--output-format stream-json` + `-p` 非交互模式调用 step-pilot
- **隔离执行**：每个 task 在独立临时目录，用 `git init` 创建 fixture repo

---

## 10. 第一阶段：3-task vertical slice

### Tasks

1. **single-file-bug-001** — off-by-one loop
2. **multi-file-bug-001** — API contract mismatch
3. **long-horizon-001** — debug failing test, fix, re-run

### 目标

证明整个 pipeline 能跑通：
- fixture 创建
- step-pilot 调用
- stream-json 解析
- checks 执行
- result 收集
- 报告生成

### 不要求

- 20 tasks 全量
- baseline 自动化对比
- 复杂 dashboard

---

## 11. 下一步

1. 实现 `benchmark/tasks/` 下的 3 个 task fixtures
2. 实现 `benchmark/runner.ts`：调用 step-pilot、收集 stream-json、执行 checks
3. 实现 `benchmark/reporter.ts`：生成 JSON/Markdown 报告
4. 实现 CLI：`pnpm benchmark list/run/report`
5. 跑通 vertical slice，输出第一次 benchmark 结果
