<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">简体中文</a>
</p>

> [!IMPORTANT]
> **非官方社区探索项目。** Step Pilot 源自 `stepfun-ai/Step-Realtime-CLI` 的 `step-code-explore-pi` 分支快照（commit `db7dd58`，2026-08-21），并自 2026-09-02 起由社区独立维护和持续演进。

# Step Pilot

> **一个围绕 Step 模型构建的轻量级终端 Coding Agent，配备可观测、面向恢复的 agent harness。**

Step Pilot 是一个终端 coding agent。模型调用工具读写真实文件、跑真实命令，并持续迭代直到任务完成——而失败、恢复与验证的每一步都是**可见的**，不是黑箱。

## 设计哲学

> 模型能力只是有效 coding agent 的一部分。Step Pilot 探索的是：**一个轻量模型，配上刻意设计的 harness，能走多远。**

Step 3.7 Flash 这类轻量模型又快又便宜，但传统 agent 脚手架会让它们崩：过长的 system prompt、失控的工具输出、偷懒的压缩，会在真正干活前就把上下文吃光。所以 Step Pilot 把 harness 本身当作产品：

| harness 关注点 | Step Pilot 的实际做法 |
|---------------|---------------------|
| 上下文 | ~2000 字符 system prompt；工具结果上限 400K 字符；75% 触发压缩，用户消息保留 20K token 保真预算 |
| 恢复 | `maxIterations` 硬上限、分档轮次告警、no-progress 检测、结构化错误反馈回模型 |
| 验证 | 不接受模型自报完成——`step mission verify` 执行接受标准并留存证据 |
| 可观测 | 每次 run 都产出结构化事件（`wire.jsonl`）；benchmark 复用同一套事件 |
| 安全 | 权限三档，高风险命令默认要求确认 |

上表每一项都对应 `src/` 里真实存在的模块。详见 [harness](./docs/zh/harness.md)。

## 功能

- **终端 UI** —— 基于 pi-tui：流式输出、工具活动、diff、可展开结果
- **流式** —— 模型输出流式呈现，工具执行实时反馈（provider 不支持时优雅降级）
- **工具使用** —— 文件系统、shell、搜索、web、任务，需要时还有子 agent
- **上下文工程** —— 结果上限、预处理、压缩，让上下文保持为「预算」而不是「日志」
- **迭代修复** —— 失败以结构化反馈回给模型，而不是盲目重试
- **验证** —— 独立 verifier + 证据包；完成必须挣来
- **会话** —— 可持久化、可恢复、可 fork，支持非交互 `stream-json`
- **轨迹** —— 每次 run 的结构化事件，可直接用于分析
- **Benchmark 模式** —— 跑本地任务，量化 harness 到底改变了什么

## 快速上手

首次运行是交互式向导——它会引导你完成 API key、provider 和模型选择，无需手动编辑配置文件。

制品通过 GitHub Releases 分发（不走 npm 公共仓库）。用 npm 安装最新 Release 的 tarball：

```bash
npm i -g https://github.com/Zi-Yi-Ming/step-pilot/releases/latest/download/step-pilot.tgz
step-pilot
```

需要 Node.js >= 22。不想装 Node 就到 [Releases](https://github.com/Zi-Yi-Ming/step-pilot/releases/latest) 下载对应平台的单文件可执行；要改代码请走源码安装。

常用入口：

```bash
step-pilot                              # 交互式 TUI
step-pilot "fix the failing tests"      # 跑一个任务后退出
step-pilot --model step-3.7-flash       # 覆盖模型
step-pilot -y                           # yolo：不确认
step-pilot -p "任务" --output-format stream-json   # 非交互，适合 CI
step-pilot session list                 # 列出会话
step-pilot -r                           # 恢复会话
```

更细的安装与配置见[快速开始](./docs/zh/quickstart.md)，各安装方式的取舍见[安装](./docs/zh/installation.md)。

如果你手上已经有别的 AI agent，仓库里的 [`skills/step-pilot-install/`](./skills/step-pilot-install/SKILL.md) 是一份安装说明技能：clone 后让你的 agent 读它，它就知道怎么装、怎么配 key、装不上时怎么排查。

## 示例

一次**真实**运行，不是示意。任务 `cascading-fix-001` 在三个文件里埋了 3 个互相独立的 bug——每跑一次测试才暴露下一个。模型 `step-3.7-flash`，2026-09-18 实跑。

```
> Debug the failing test suite. There are 3 independent bugs across 3 source files.
> Run 'npx vitest run' after each fix to reveal the next bug.

→ list_dir                       检视仓库
→ read_file  parser.ts           定位 bug
→ read_file  filter.ts
→ read_file  formatter.ts
✓ edit_file  parser.ts           修 JSON parser
→ bash       npx vitest run
✗ 2 failed                       ✓ parses json | × filters active | × formats output
✓ edit_file  filter.ts           修 active filter
→ bash       npx vitest run
✗ 1 failed                       ✓ parses json | ✓ filters active | × formats output
✓ edit_file  formatter.ts        修 HTML formatter
→ bash       npx vitest run
✓ 3 passed                       Test Files 1 passed | Tests 3 passed (3)

Completed
  轮次: 10    工具调用: 13    已恢复的工具错误: 2    耗时: 42.2s
  验证: 1 passed / 0 failed
```

这个**递进过程**才是重点：agent 没有直接宣布成功——它跑测试、读失败、改代码、再跑，一共三轮。

**这里刻意不列 token 数。** Step 三协议的 `reasoning_tokens` 恒为 0、思考消耗不可观测；本次 run 上报的 input/output/total 三个数彼此矛盾。与其发布一个我们自己都不敢背书的数字，不如只发布 harness 真正测得的量。见 [benchmark](./docs/zh/benchmark.md)。

原始结果：[`benchmark/results/demo-cascading-fix.json`](./benchmark/results/demo-cascading-fix.json)。

## 架构

```
        User
         ↓
        TUI  (pi-tui)
         ↓
   Agent Runtime
   ├── Context Manager      结果上限、预处理、压缩
   ├── Planner              goals、tasks、todos、plan mode
   ├── Tool Registry        36 个模块，受权限约束
   ├── Recovery             迭代上限、no-progress、结构化错误
   ├── Verification         post-green、Mission verifier + 证据
   └── Session / Trace      快照 + 只追加的 wire.jsonl
         ↓
     Provider  (Step / OpenAI Chat / Responses / Anthropic)
         ↓
      Step Model
```

源码分层：`config` → `provider` → `tools` → `agent`（循环）→ `tui-pi`（pi-tui）→ `cli.ts`（入口）；`main.ts` 只是 bin 引导（先设 NODE_ENV 再加载 cli.js）。完整模块边界见[架构](./docs/zh/architecture.md)。

## 文档

英文文档在 [`docs/en/`](./docs/en/)；`docs/` 下的中文原文是 source of truth。

| 文档 | 内容 |
|------|------|
| [快速开始](./docs/zh/quickstart.md) | 安装、配 key、第一次对话 |
| [安装](./docs/zh/installation.md) | 环境要求、源码构建、全局命令、升级卸载 |
| [配置参考](./docs/zh/configuration.md) | config.toml 全字段、多协议渠道与模型别名、环境变量、数据目录 |
| [架构](./docs/zh/architecture.md) | 模块边界、分层、数据流、不能破坏的边界 |
| [Harness](./docs/zh/harness.md) | 上下文管理、重试、恢复、验证、轨迹——本项目的核心 |
| [交互使用](./docs/zh/interactive.md) | TUI 界面、斜杠命令、快捷键、权限三档、计划模式、切模型与渠道 |
| [工具集](./docs/zh/tools.md) | 全部内置工具的参数与行为边界、并行执行与结果回灌机制 |
| [会话管理](./docs/zh/sessions.md) | 持久化、续接与恢复、分叉、上下文压缩、回顾、非交互输出 |
| [Mission](./docs/zh/mission.md) | 可恢复、可审计的任务：事实链、检查点、恢复、独立 verifier |
| [Benchmark](./docs/zh/benchmark.md) | 如何跑任务、记录哪些指标、为什么历史数字不可引用 |
| [故障排查](./docs/zh/troubleshooting.md) | 症状、原因与处理 |
| [子 agent 与自动化](./docs/zh/agents.md) | spawn_agent、dynamic_workflow、自主目标、定时任务、后台任务 |
| [技能、插件与 MCP](./docs/zh/skills-and-mcp.md) | SKILL.md 格式、加载层级、plugin、MCP 接入 |
| [hooks 机制](./docs/zh/hooks.md) | 五个生命周期事件点执行 shell 命令 |
| [Step 3.7 Flash 最佳实践](./docs/zh/best-practices.md) | 如何让小模型在 step-pilot 里发挥最好 |

## 开发

```bash
pnpm dev          # tsx 直接跑，交互式开发
pnpm typecheck    # tsc 严格模式
pnpm test         # vitest
pnpm benchmark run --runs 1   # 跑本地 benchmark
```

CI 在 Ubuntu、Windows、macOS 三平台运行 typecheck、build 与 test。开发约定与模型接入铁律见 [`AGENTS.md`](./AGENTS.md)，贡献流程见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 致谢

step-pilot 基于 pi 开源生态构建——TUI/agent 壳使用 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi)（pi 仓库的 `packages/tui`），并源自 stepfun-ai `Step-Realtime-CLI` 的 `step-code-explore-pi` 探索分支快照。本项目在此基础上独立修复上游问题、针对 Step 3.7 Flash 等小模型重新调优；与 earendil-works、stepfun-ai 等第三方项目无隶属、赞助或背书关系。第三方开源许可证原文收录于 [`licenses/`](./licenses/) 目录作为合规留痕，详见 [`licenses/NOTICE.md`](./licenses/NOTICE.md)。

## 许可证

MIT，详见 [`LICENSE`](./LICENSE)。第三方致谢与许可证见 [`licenses/`](./licenses/)。
