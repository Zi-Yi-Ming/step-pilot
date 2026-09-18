# 架构

> 本页说明模块边界与数据流。改代码前先读它；新增能力应当落进既有层，而不是另起一套。

## 一句话

Step Pilot 是一个终端 coding agent：模型调用工具读写真实文件、跑真实命令，结果回流进循环，直到任务完成或被明确停止。它的重点不在「接模型」，而在**围绕模型刻意设计的 harness**——上下文工程、工具契约、失败恢复、验证与可观测。

## 分层

```
                        ┌─────────────┐
   用户输入 ───────────▶ │   cli.ts    │  参数解析、子命令、非交互模式
                        └──────┬──────┘
                               │
                        ┌──────▼──────┐
                        │   tui-pi    │  pi-tui 渲染层（表现层，不承载决策）
                        │  + chat/    │  流式缓冲、diff、命令、输入
                        └──────┬──────┘
                               │ 事件流
   ┌───────────────────────────▼────────────────────────────┐
   │                      agent（harness 核心）              │
   │  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
   │  │  loop   │ │  turns   │ │ scheduler│ │ permission │  │
   │  │ 迭代主控 │ │ 轮次派生 │ │ 并行调度 │ │  权限判定   │  │
   │  └────┬────┘ └──────────┘ └──────────┘ └───────────┘  │
   │       │                                                │
   │  ┌────▼──────────┐  ┌────────────┐  ┌───────────────┐ │
   │  │  compaction   │  │ toolResult │  │  wire / wirelog│ │
   │  │ 上下文压缩    │  │ 结果裁剪   │  │  结构化事件    │ │
   │  └───────────────┘  └────────────┘  └───────────────┘ │
   └───────┬──────────────────────────┬────────────────────┘
           │                          │
    ┌──────▼───────┐          ┌───────▼────────┐
    │    tools     │          │    session     │
    │ 工具注册/执行 │          │ 持久化 + 轨迹  │
    └──────┬───────┘          └────────────────┘
           │
    ┌──────▼───────┐
    │   provider   │  多协议适配、重试、能力降级
    └──────┬───────┘
           │
    ┌──────▼───────┐
    │    config    │  TOML / 环境变量 / 模型别名
    └──────────────┘
```

`main.ts` 只是 bin 引导：先设 `NODE_ENV`，再加载 `cli.js`。

## 各层职责

### config（`src/config/`）

读 `~/.step-pilot/config.toml`、`.env` 与环境变量，解析服务商预设与模型别名。输出一份稳定的运行配置给上层。**这一层不认识 agent 语义。**

### provider（`src/provider/`）

把四种协议（Step/Anthropic Messages、OpenAI Chat Completions、OpenAI Responses）统一成同一套事件流：

- `factory.ts` 按渠道 `type` 分发装配
- `step/` 处理阶跃专属语义（三协议的思考参数名与嵌套层级各不相同，`stepCommon.ts` 统一翻译）
- `retry.ts` 指数退避 + 可重试判定，并把「空响应」「流空闲超时」「max_tokens 耗尽」分别建模为 `EmptyResponseError` / `StreamIdleTimeoutError` / `MaxTokensExhaustedError`
- `capability-registry.ts` + `degrader.ts` 按模型能力主动降级（媒体块占位化、thinking 剥离、cache_control 剥离）

**边界**：provider 只负责「把请求发出去、把响应翻成事件」。它不决定任务是否完成。

### tools（`src/tools/`）

36 个模块，`index.ts` 统一注册。每个工具是 `name + description + input_schema + execute()`，并受权限层约束。

- 文件系统：`readFile` / `write` / `edit` / `listDir` / `glob` / `grep`（grep 带 ReDoS 守卫）
- 执行：`bash`（含跨平台 `shellResolve`，Windows 探测 Git Bash → WSL → busybox → PowerShell，不回退 cmd.exe）
- 其他：`task` / `todoList` / `webFetch` / `webSearch` / `skill` / `spawnAgent` / `team` / `dynamicWorkflow`

**边界**：工具不自己判断「任务完成没有」，它只返回结构化结果。

### agent（`src/agent/`）—— harness 核心

| 模块 | 职责 |
|------|------|
| `loop.ts` | 迭代主控：`maxIterations`（默认 500）、mid/late 分档轮次告警、`noProgress` 检测 |
| `roundLoop.ts` / `thinkingLoop.ts` / `runTurn.ts` | 单回合编排：流式 → tool_use → 授权执行 → 回灌 |
| `turns.ts` | 轮次派生与按轮截断 |
| `toolScheduler.ts` | 并行工具调度：资源冲突判定、乱序执行、按序回收 |
| `toolResultLimit.ts` / `toolResultPreprocess.ts` | 工具结果上限（400K 字符）与预处理，防止单次输出淹没上下文 |
| `compaction/compact.ts` | 微压缩 + 全量摘要压缩（默认 75% 触发，摘要时保留最近 6 条，用户消息 20K token 保真） |
| `permission/mode.ts` | 权限三档 manual / auto / yolo，plan 模式硬拦 |
| `wire.ts` / `wirelog.ts` | 结构化事件（事实源） |
| `systemPrompt.ts` / `agentsMd.ts` | ~2000 字符系统提示与项目约定加载 |
| `mission/` | 任务控制面：事实链、检查点、恢复分析、独立 verifier |

### session（`src/session/`）

`SessionStore` 落 JSON 快照，`wire.jsonl` **只追加**作为事实源；快照是检查点、事件是事实源。支持 resume / continue / fork 与非交互 `stream-json` 输出。

### tui-pi + chat（表现层）

`PiChat` 是组合根，消费 agent 事件流渲染；`chat/` 提供流式缓冲、diff 视图、命令、输入历史等。**这一层不得反向侵入 agent 决策。**

## 一次任务的完整数据流

```
用户输入
  ↓
cli 解析（交互 / -p 非交互）
  ↓
config 解析出 provider + 模型
  ↓
agent loop：
  OBSERVE  组装上下文（system + 任务 + 仓库 + 近期对话 + 工具结果）
  REASON   请求模型，流式吐出 thinking / text / tool_use
  ACT      权限判定 → 执行工具（可并行）→ 结构化结果
  OBSERVE  结果裁剪后回灌；必要时触发 compaction
  …循环，直到模型停止调用工具
  ↓
验证（postGreen / mission verify）
  ↓
session 落盘 + wire 事件追加
  ↓
TUI 呈现
```

## 设计取舍（为什么是这样）

1. **事件是事实源，快照是派生物。** 快照可重建；事件只追加。这样恢复、回放、benchmark 共用同一份真相。
2. **上下文是预算，不是日志。** 工具结果有上限、会裁剪、会压缩；宁可丢旧细节，也不让上下文无界增长。
3. **provider 可替换，harness 不可替换。** 换模型只改配置；harness 的行为（压缩时机、重试边界、权限判定）是产品本身。
4. **表现层可替换。** 已有 pi-tui 前端；`-p` 非交互与 `stream-json` 让 CI/benchmark 能脱离 TUI 使用同一套 agent。

## 不能破坏的边界

- 不要在 `tui-pi/` 或 `chat/` 里做任务决策。
- 不要让 `provider/` 判断任务完成。
- 不要让工具自己决定重试策略（重试在 agent 与 provider 层）。
- Mission 的事件**不写进会话 `wire.jsonl`**——两者生命周期不同，混写会污染会话恢复。
