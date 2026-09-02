<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">简体中文</a>
</p>

> [!IMPORTANT]
> **非官方 —— 社区自主探索的 CLI。** Step Pi 由社区贡献者自主探索实现。

# Step Pi

[![CI](https://github.com/Zi-Yi-Ming/step-pi/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Zi-Yi-Ming/step-pi/actions/workflows/test.yml)

终端里的编码 agent CLI，专为 **Step 3.7 Flash 的稳定性**优化。它甩掉了让小型模型失效的重型 prompt 堆和膨胀上下文预算：~2000 字符的 system prompt、更紧的工具结果上限、更早触发压缩——让 Flash 真正能遵循指令，同时在你需要时保留 agent loop、子 agent 和插件系统。

## 为什么选 steppi

小型前沿模型又快又便宜，但传统 agent  scaffolding 会让它们崩溃：过长的 system prompt、失控的工具输出、懒散的上下文压缩，在真正干活前就把 context window 吃光了。

steppi 把小模型指令遵循当作一等约束：

- **~2000 char system prompt** — 最小可用指令集，不是什么都塞的清单
- **工具结果上限 200K 字符** — 阻止单条失控命令淹没模型
- **压缩更早触发、保留更少** — 默认在 75% context 触发压缩，摘要时只保留最近 4 条消息；用户原话保真预算 10K token
- **更清晰的工具契约** — 核心工具描述重写，减少指令歧义

目标不是让 Flash 表现得像 700B 模型。而是停止在无关紧要的东西上浪费它的上下文，让真正重要的指令被正确执行。

## 它是什么

steppi 是一个终端编码 agent CLI。模型通过工具读写真实文件、执行真实命令、派生子 agent；结果回灌进循环继续推进，直到任务完成。

它用 **pi-tui** 构建 UI，支持三种协议 —— Anthropic Messages、OpenAI Chat Completions、OpenAI Responses —— 任何兼容的模型都能直接接入。Step 是默认且经过最充分验证的目标。

## 快速上手

首次运行是交互式向导 —— 它会引导你完成 API key、provider 和模型选择，无需手动编辑配置文件。

```bash
npm i -g steppi
steppi
```

需要 Node.js >= 22。不想装 Node 就到 [Releases](https://github.com/Zi-Yi-Ming/step-pi/releases/latest) 下载对应平台的单文件可执行；要改代码请走源码安装。

更细的安装与配置见[快速开始](./docs/zh/quickstart.md)，四种安装方式的取舍见[安装](./docs/zh/installation.md)。

如果你手上已经有别的 AI agent，仓库里的 [`skills/steppi-install/`](./skills/steppi-install/SKILL.md) 是一份安装说明技能：clone 后让你的 agent 读它，它就知道怎么装、怎么配 key、装不上时怎么排查。

## 文档

| 文档 | 内容 |
|------|------|
| [快速开始](./docs/zh/quickstart.md) | 安装、配 key、第一次对话 |
| [安装](./docs/zh/installation.md) | 环境要求、源码构建、全局命令、升级卸载 |
| [配置参考](./docs/zh/configuration.md) | config.toml 全字段、多协议渠道与模型别名、环境变量、数据目录 |
| [交互使用](./docs/zh/interactive.md) | TUI 界面、斜杠命令、快捷键、权限三档、计划模式、切模型与渠道 |
| [工具集](./docs/zh/tools.md) | 全部内置工具的参数与行为边界、并行执行与结果回灌机制 |
| [子 agent 与自动化](./docs/zh/agents.md) | spawn_agent、dynamic_workflow、自主目标、定时任务、后台任务 |
| [会话管理](./docs/zh/sessions.md) | 持久化、续接与恢复、分叉、上下文压缩、回顾、非交互输出 |
| [技能、插件与 MCP](./docs/zh/skills-and-mcp.md) | SKILL.md 格式、加载层级、plugin、MCP 接入 |
| [hooks 机制](./docs/zh/hooks.md) | 五个生命周期事件点执行 shell 命令 |
| [AGENTS.md 机制](./docs/zh/agents-md.md) | 项目规范怎么加载、覆盖、自定义来源 |

## 开发

源码分层：`config` → `provider` → `tools` → `agent`（循环）→ `tui-pi`（pi-tui）→ `cli.ts`（入口）；`main.ts` 只是 bin 引导（先设 NODE_ENV 再加载 cli.js）。

```bash
pnpm dev          # tsx 直接跑，交互式开发
pnpm typecheck    # tsc 严格模式
pnpm test         # vitest
```

CI 在 Ubuntu、Windows、macOS 三平台运行 typecheck、build 与 test。开发约定与模型接入铁律见 [`AGENTS.md`](./AGENTS.md)，贡献流程见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 致谢

Step Code 的源码由本项目自行编写，与任何第三方项目无隶属、赞助或背书关系。第三方开源许可证原文收录于 [`licenses/`](./licenses/) 目录作为合规留痕，详见 [`licenses/NOTICE.md`](./licenses/NOTICE.md)。

## 许可证

MIT，详见 [`LICENSE`](./LICENSE)。第三方致谢与许可证见 [`licenses/`](./licenses/)。
