# Small-Model Agent Reliability Review — step-pilot

> 本文档是 2026-09 对 step-pilot 仓库的产品与架构审查结论，用于指导下一阶段优先级决策。
> 核心假设：step-pilot 的核心价值不是功能比其他 Coding Agent 更多，而是让快速、便宜、较小的模型也能稳定完成真实编码任务。

---

## 1. 当前真正的核心能力

以下代码路径是直接支撑 **small-model coding agent reliability** 的：

| 能力 | 代码位置 | 状态 |
|------|----------|------|
| 上下文压缩（micro + full） | `src/agent/compaction/` | 成熟，有质量闸门、中断安全、overflow 收缩 |
| 工具结果截断（双层：语义预处理 + 字符兜底） | `src/agent/toolResultPreprocess.ts` + `toolResultLimit.ts` | 成熟，但预处理只覆盖 bash/read_file/mcp |
| 思考档位控制（三协议统一） | `src/provider/step/stepCommon.ts` + `stepMessages.ts` | 成熟，已解决静默无效问题 |
| 错误分型（截断 / 思考耗尽 / 真正空响应） | `src/provider/retry.ts` + `src/agent/runTurn.ts` | 成熟，类型级区分 |
| 工具调用泄漏检测 | `src/agent/runTurn.ts` `TOOL_CALL_LEAK_PATTERNS` | 仅覆盖全泄漏，部分泄漏未处理 |
| 重试循环拦截 + 自动禁用 | `src/agent/runTurn.ts` + `src/mcp/manager.ts` | 刚完成（0.1.10） |
| 会话持久化 + 恢复 | `src/session/store.ts` | 成熟，双写 + 断链闭合 |
| 模型能力降级（主动 + 被动） | `src/provider/adapter.ts` + `degrader.ts` | 框架就绪，但 `CAPABILITY_TABLE` 为空 |

---

## 2. 开始偏离核心的方向

| 方向 | 当前状态 | 判断 |
|------|----------|------|
| MCP 生态深耕 | 已具备 stdio + HTTP + OAuth + timeout + retry + auto-disable + env expansion | **已足够**。继续加 feature 边际收益递减 |
| Team 模式 | 已实现（git worktree 隔离 + 五道门） | **P2**。真实有用但非小模型可靠性核心 |
| Dynamic Workflow | QuickJS 沙箱 + JS 编排 | **P2**。小模型写 JS 编排本身是额外负担 |
| Sub-agent | 已实现 | **P1**。小模型受益于拆分任务，但当前实现已够用 |
| TUI Polish | pi-tui 渲染层大量文件 | **P1 边缘**。可用即可，不需持续投入 |
| Plugin 系统 | 发现 + 能力合流 | **P1 边缘**。生态尚未形成，先保证核心体验 |
| 多 Provider 抽象 | 三协议 + Step 专属 adapter | **P1**。必要但不需继续扩张协议 |
| Memory 观察池 | `/memory` 默认关闭 | **DROP**。无 embedding、无后台提取，价值有限 |
| VS Code 扩展 | 计划中（Week 2-3） | **P2**。扩大覆盖面的尝试，非小模型可靠性核心 |

---

## 3. 当前最大的技术瓶颈

### 3.1 首回合压缩预检系统性低估

`loop.ts` 的 `preflightUsed` 在首回合退回纯字符估算，**系统性低估约 2x**（不含 system prompt + tool schema）。结果是：
- 首回合不触发压缩
- 长会话能一路涨到接近满窗仍不压缩
- 小模型在长上下文中表现急剧下降

**这是最值得修复的瓶颈。**

### 3.2 部分工具调用泄漏未检测

`TOOL_CALL_LEAK_PATTERNS` 只在 `toolUses.length === 0` 时触发。如果模型产生 1 个结构化 block + 1 个 leaked XML tag，泄漏不可见。

### 3.3 主动能力降级框架空转

`CAPABILITY_TABLE` 为空，config.toml 能力声明段未接入。`degradeMessages` 只对 `cache_control` 和 `video_in` 生效，其他能力声明路径从未被触发。

### 3.4 事件日志无界增长

`.wire.jsonl` 单调增长，无旋转/压缩策略。长会话文件可变得极大。

---

## 4. 产品定位

### 4.1 用户为什么选择 step-pilot

> **step-pilot 是唯一专门为小模型设计的 coding agent runtime。**

其他 agent（Claude Code、Codex、OpenCode、pi）都是为大模型设计的，然后把配置暴露给用户。它们假设：
- 模型能处理 128K+ 上下文
- 模型能可靠地遵循复杂 system prompt
- 模型不会在长工具输出中迷失
- 模型能自我纠正 malformed tool call

这些假设对 7B–30B 参数的小模型不成立。

step-pilot 的不同之处：
1. **上下文是稀缺资源，不是免费带宽** — 自适应压缩、用户原话保真、双层工具结果截断
2. **错误是类型，不是字符串** — `thinking_exhausted` vs `max_tokens` vs `EmptyResponseError`，runtime 按类型路由
3. **模型能力是声明，不是假设** — 主动降级（图片→占位、thinking→剥离）在发送前执行
4. **失败是可恢复的状态** — retry loop 自动禁用、dangling tool-use 闭合、会话可恢复

### 4.2 推荐方向：Direction B — Small-Model Coding Agent

| 维度 | Direction A（通用） | Direction B（小模型专用） | Direction C（Runtime） |
|------|---------------------|---------------------------|------------------------|
| 用户价值 | 与 Claude Code / Codex 正面竞争 | 填补市场空白：小模型 coding agent | 技术产品，用户群体模糊 |
| 技术壁垒 | 低（功能可复制） | 中高（需要真实的小模型实测调优） | 高（抽象难度大） |
| 项目可持续性 | 需要持续 Feature 对抗 | 以 reliability 为核心指标，可预测 | 抽象成本高，落地难 |
| 差异化 | 弱 | 强（定位清晰） | 强但受众窄 |
| 开源传播潜力 | 中 | 高（小模型社区增长快） | 低（开发者工具） |
| 开发成本 | 高（永无止境） | 中（有明确优化目标） | 高（抽象 + 多后端） |
| 与当前代码匹配 | 中 | **高** | 中 |

**推荐：Direction B**。当前代码基础已经是 small-model-first 的，继续深化这个定位比转型做通用 agent 或 runtime 都更自然、更有价值。

---

## 5. 优先级

### P0 — 核心竞争力

| 项目 | 原因 |
|------|------|
| 首回合压缩预检修正 | 系统性低估 2x 是最隐蔽的可靠性杀手 |
| 部分工具调用泄漏检测 | 小模型高频故障点，当前只覆盖全泄漏 |
| 能力降级框架激活 | 已写好但空转，接通 config.toml 即可生效 |
| thinking 档位全链路验证 | 0.1.9–0.1.10 已修核心 bug，需回归护栏 |
| 事件日志压缩策略 | 长会话文件无界增长，影响恢复性能 |

### P1 — 重要，服务于 P0

| 项目 | 原因 |
|------|------|
| MCP 工具链稳定性 | 已足够完善，保持即可 |
| 会话恢复健壮性 | dangling tool-use 闭合已做，需边界测试 |
| Sub-agent 阈值对齐 | 子 agent 继承父级压缩阈值，context window 不同时可能错配 |
| Tool result 预处理扩展 | 当前只覆盖 3 类工具，grep/web_fetch 等也应纳入 |

### P2 — 以后再做

| 项目 | 原因 |
|------|------|
| VS Code 扩展 | 扩大覆盖面，非小模型可靠性核心 |
| Team 模式 | 已实现，非当前瓶颈 |
| Dynamic Workflow | 小模型写 JS 编排是额外负担 |
| TUI 持续 polish | 可用即可 |

### DROP — 暂时冻结

| 项目 | 原因 |
|------|------|
| Memory 观察池 `/memory` | 无 embedding、无后台提取，价值有限 |
| Agent marketplace | 生态尚未形成 |
| Swarm / 多 agent 框架 | 超出 coding agent 范畴 |
| Web UI | 与终端定位矛盾 |
| 新 Provider 扩张 | 三协议已覆盖主要需求 |
| 大量 TUI 动效 | 不提高 reliability |

---

## 6. 小模型可靠性架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Small-Model Agent Runtime                 │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Context     │  │ Tool         │  │ Error             │  │
│  │ Management  │  │ Reliability  │  │ Typing            │  │
│  ├─────────────┤  ├──────────────┤  ├───────────────────┤  │
│  │ - Preflight │  │ - Preprocess │  │ - EmptyResponse   │  │
│  │   compression│  │ - Cap 400K   │  │ - MaxTokensExhaust│  │
│  │ - Adaptive  │  │ - Scheduler  │  │ - StreamIdle      │  │
│  │   thresholds│  │ - Retry loop │  │ - Thinking downgrade│ │
│  │ - Thinking  │  │ - Auto-disable│  │ - Leak detection  │  │
│  │   level aware│  │ - Conflict   │  └───────────────────┘  │
│  │ - Overflow  │  │   detection  │                           │
│  │   shrink    │  └──────────────┘                           │
│  └─────────────┘                                             │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Model-Aware │  │ Session      │  │ Recovery          │  │
│  │ Degradation │  │ Continuity   │  │                   │  │
│  ├─────────────┤  ├──────────────┤  ├───────────────────┤  │
│  │ - Capability│  │ - Dual-write │  │ - Dangling tool   │  │
│  │   registry  │  │ - Wire log   │  │   closure         │  │
│  │ - Proactive │  │ - Resume     │  │ - Index rebuild   │  │
│  │   strip     │  │ - Compaction │  │   on stale        │  │
│  │ - Reactive  │  │   integration│  │ - Crash-safe log  │  │
│  │   reproject │  └──────────────┘  └───────────────────┘  │
│  └─────────────┘                                             │
└─────────────────────────────────────────────────────────────┘
```

### 机制价值评估

| 机制 | 价值 | 副作用 | 结论 |
|------|------|--------|------|
| 双层工具结果截断 | 高 | 无 | 保留，扩展覆盖工具 |
| 自适应压缩门槛 | 中 | thinkingLevel 耦合 | 保留，修首回合低估 |
| Preflight 压缩 | 高 | 首回合低估 | **修复** |
| thinking 档位控制 | 高 | 参数语义复杂 | 保留，加回归测试 |
| 错误分型 | 高 | 无 | 保留 |
| 重试循环 + 自动禁用 | 高 | 无 | 保留 |
| 能力降级 | 中 | 框架空转 | **激活** |
| 泄漏检测 | 中 | 仅覆盖全泄漏 | 扩展部分泄漏 |
| 事件日志压缩 | 低 | 无 | 补充旋转策略 |

---

## 7. 长任务失败点分析

### 典型任务流程

> 用户给出一个真实 bug → agent 阅读多个文件 → 使用 grep / read / bash → 修改多个文件 → 跑测试 → 遇到失败 → 修复 → 完成任务

### 最容易让小模型失控的点

| 阶段 | 风险 | 当前防护 | 缺口 |
|------|------|----------|------|
| 阅读多个文件 | 上下文快速膨胀，首回合预检低估 | micro/full compaction | **首回合 2x 低估导致压缩不触发** |
| grep 大结果 | 工具输出淹没上下文 | 400K cap + 预处理 | 仅 bash/read_file/mcp 有预处理 |
| bash 长输出 | 同上 | 同上 | 同上 |
| 修改多个文件 | 模型可能丢失原始 bug 描述 | 用户原话保真 20K | 摘要可能漏掉关键细节 |
| 跑测试失败 | 模型可能陷入重试循环 | retry loop 3 次拦截 | 无 |
| 修复后重跑 | 上下文已满，新输出进一步膨胀 | compaction 触发 | 首回合问题同上 |

### 模型负责什么 vs Runtime 负责什么

**模型负责：**
- 理解 bug 的根本原因
- 规划修复步骤
- 正确调用工具（参数、路径、命令）
- 解释测试失败原因
- 编写正确的代码修改

**Runtime 应该负责：**
- 控制上下文窗口不溢出
- 截断工具结果到模型可处理的尺寸
- 检测 malformed tool call 并重试或中止
- 区分"预算耗尽"和"真正失败"，给出不同提示
- 自动禁用持续失败的工具
- 在压缩时保留用户原始需求和关键决策
- 恢复时闭合 dangling tool-use
- 检测模型是否陷入循环（round-loop、thinking-loop）

**核心原则：Runtime 应该把模型从"上下文管理"中解放出来，让它专注于"问题解决"。**

---

## 8. Benchmark 评估与设计

### 是否值得做？

**值得做，但要轻量。**

理由：
1. 当前所有 small-model 优化都是基于经验和单点实测，缺乏系统性回归数据
2. 没有 benchmark 就无法判断新改动是"真的更可靠"还是"只是改了代码"
3. 小模型行为随版本变化快，需要持续追踪

### 最小可行 Benchmark 设计

#### 目录结构

```
benchmark/
├── tasks/
│   ├── single-file-bug/
│   │   ├── 001-off-by-one/
│   │   │   ├── task.md
│   │   │   ├── setup.sh
│   │   │   ├── verify.sh
│   │   │   └── expected/
│   │   │       └── files.yaml
│   │   └── ...
│   ├── multi-file-bug/
│   ├── test-writing/
│   ├── refactoring/
│   ├── repo-exploration/
│   ├── tool-heavy/
│   ├── long-horizon/
│   └── mcp/
├── runner.ts
├── reporter.ts
└── README.md
```

#### Task 定义格式

```yaml
id: single-file-bug-001
category: single-file-bug-fix
difficulty: easy
description: "Fix the off-by-one error in the loop boundary"
setup: |
  # 创建一个包含 bug 的仓库
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
verify: |
  cd repo && npx vitest run  # 应该通过
success_criteria:
  tests_pass: true
  files_modified: ["src/utils.ts"]
  max_turns: 10
```

#### 20 个 Task 设计

**Single-file bug fix (3)**
1. Off-by-one in loop boundary
2. Missing null check causing crash
3. Wrong comparison operator in sort

**Multi-file bug fix (3)**
4. API contract mismatch (caller/callee disagree on format)
5. Import cycle causing undefined reference
6. Config key rename missed in one consumer

**Test writing (2)**
7. Write unit tests for a pure function with edge cases
8. Write integration test for a CLI command

**Refactoring (2)**
9. Extract duplicated logic into a shared utility
10. Rename a confusingly named function across 3 files

**Repository exploration (2)**
11. Find where user authentication happens
12. Identify all places where a specific config key is read

**Tool-heavy task (2)**
13. Bulk rename files based on a mapping
14. Generate boilerplate for 5 new endpoints following existing pattern

**Long-horizon task (3)**
15. Implement a feature requiring 4+ file changes
16. Debug a failing CI pipeline by reading logs and fixing root cause
17. Migrate a config format across 10+ files

**MCP task (2)**
18. Use an MCP file-system server to explore and edit a remote repo
19. Chain 3 MCP tool calls to fetch, parse, and summarize external data

**Recovery / failure handling (2)**
20. Agent must recover from a test failure by reading the error and fixing
21. Agent must handle a missing tool gracefully and find an alternative

**Stress / context pressure (1)**
22. Long conversation where compaction must fire multiple times

#### Runner 设计

```typescript
// benchmark/runner.ts
interface BenchmarkResult {
  taskId: string;
  category: string;
  success: boolean;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  retries: number;
  compactions: number;
  contextPeak: number;
  totalTokens: number;
  executionTimeMs: number;
  model: string;
  error?: string;
}

async function runTask(task: TaskDef): Promise<BenchmarkResult> {
  // 1. 创建临时目录，执行 setup.sh
  // 2. 启动 step-pilot -p，传入 task.description
  // 3. 收集 stream-json 输出
  // 4. 统计 turns, tool_calls, errors, compactions
  // 5. 执行 verify.sh，检查 success_criteria
  // 6. 返回结果
}
```

#### 执行方式

```bash
# 运行全部 benchmark
BENCHMARK_API_KEY=sk-xxx pnpm benchmark

# 运行单个 category
pnpm benchmark --category single-file-bug

# 运行单个 task
pnpm benchmark --task single-file-bug-001

# 对比 baseline（简单 agent loop）
pnpm benchmark --baseline
```

#### 对比 Baseline

Baseline 用一个简化 agent loop（同模型，无 compaction、无 tool preprocessing、无 error typing）运行相同 task set。差异即 step-pilot 的 reliability gain。

---

## 9. MCP 处理原则

### MCP 在 step-pilot 中的角色

> **MCP 是让小模型获得稳定、可控的外部工具能力的通道。**

不是：
- 让 step-pilot 成为 MCP 功能最全的客户端
- 展示 MCP 协议能力的试验场
- 生态扩展的核心抓手

### 保留的功能

| 功能 | 理由 |
|------|------|
| stdio transport | 本地工具最可靠的方式 |
| Streamable HTTP | 远程 server 标准 |
| OAuth + token refresh | 安全访问远程 server 的必要条件 |
| Call timeout | 防止挂起卡死整个回合 |
| Auto-disable on retry loop | 模型不持续消耗上下文在失败工具上 |
| Env var expansion | 配置灵活性 |
| Tool result preprocessing | 保护上下文窗口 |

### 已足够的功能

| 功能 | 理由 |
|------|------|
| Tool stats / server stats | 可观察性已够用 |
| Duration tracking / trends | 调试用，非核心路径 |
| `/mcp` panel commands | 管理接口已完整 |
| Config export with mcp.json | 分享模板已支持 |

### 暂时冻结的功能

| 功能 | 理由 |
|------|------|
| PKCE support | OAuth 当前场景不迫切 |
| SSE transport | 已被 streamable HTTP 取代 |
| 更多 transport 选项 | 当前两种覆盖 95% 场景 |
| MCP 工具发现增强 | 不是小模型可靠性的瓶颈 |

---

## 10. 下一阶段 Milestone

### 推荐：Small-Model Reliability Benchmark + 首回合压缩修正

**为什么选这个方向：**
1. 直接测量核心价值（small-model reliability）是否真的在提升
2. 首回合压缩低估是已识别的最大技术瓶颈，修它对可靠性有立竿见影的效果
3. Benchmark 提供回归护栏，防止后续改动破坏 reliability
4. 工作量可控，不引入新架构

### 核心改动

#### 1. 修首回合压缩预检低估

**文件**：`src/agent/loop.ts`

**改动**：首回合 `preflightUsed` 不再退回纯字符估算，而是使用一个基于已配置 `maxContextSize` 和已知消息体量的启发式估算：

```typescript
// 当前（低估 ~2x）：
const estimatedUsedWithFramework = (): number => {
  const messagesTokens = estimateTokens(messages);
  const frameworkTokens = estimateTextTokens(system) + estimateTokens(toAnthropicTools(tools));
  return messagesTokens + frameworkTokens;
};

// 改进：首回合用配置 maxContextSize 反推，避免纯字符估算的 2x 偏差
const estimatedUsedWithFramework = (): number => {
  const messagesTokens = estimateTokens(messages);
  const frameworkTokens = /* 缓存或估算 */;
  return messagesTokens + frameworkTokens;
};
```

**测试**：新增单测验证首回合预检在已知上下文规模下正确触发压缩。

#### 2. 扩展工具结果预处理覆盖

**文件**：`src/agent/toolResultPreprocess.ts`

**改动**：将 `grep`、`glob`、`web_fetch` 纳入预处理范围：

```typescript
const PREPROCESSED_TOOLS = new Set([
  'bash',
  'read_file',
  'mcp__',  // 前缀匹配
  'grep',
  'glob',
  'web_fetch',
]);
```

#### 3. 实现 Benchmark Runner

**目录**：`benchmark/`

**内容**：
- `tasks/` — 20 个 task 定义（YAML）
- `runner.ts` — 轻量执行器，调用 step-pilot -p 模式
- `reporter.ts` — 生成对比报告
- `README.md` — 使用说明

**不引入新框架**，复用现有 vitest 基础设施。

---

## 11. 实施风险

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| 首回合预检修改引入过度压缩 | 中 | 中 | 加单测覆盖边界条件；保守参数 |
| Benchmark runner 与 CLI 耦合过深 | 中 | 低 | 保持 runner 独立，通过 stream-json 交互 |
| 扩展预处理覆盖误伤合法输出 | 低 | 中 | 保留原始 cap 400K 作为兜底 |
| Benchmark 执行时间过长 | 高 | 低 | 默认只跑 5 个 quick tasks；全量需显式 flag |
| 文档最佳实践与实际行为不一致 | 已确认 | 中 | 同步修复 best-practices.md |

---

## 12. 立即行动

1. **今天**：修首回合压缩预检低估
2. **今天**：扩展工具结果预处理覆盖
3. **今天**：修复 best-practices.md 中的事实错误
4. **本周**：实现 benchmark runner + 5 个 quick tasks
5. **下周**：补全 20 个 tasks，跑 baseline 对比
