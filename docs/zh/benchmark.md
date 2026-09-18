# Benchmark

> 目标不是做世界级 benchmark，而是让开发者能回答一个问题：
> **加上 harness 以后，模型的实际表现发生了什么变化？**

## 定位

Step Pilot 既是产品，也是 agent harness 的实验项目。benchmark 是它的测量端：跑一组固定的本地任务，记录过程指标，让 harness 的改动可以被量化观察，而不是靠印象判断。

**产品运行与研究测量共用一份真相**——benchmark 消费的正是 `wire.jsonl` 那套结构化事件。

## 快速开始

```bash
pnpm benchmark list                                   # 列出任务
pnpm benchmark run --task single-file-bug-001 --runs 1 # 跑单个任务
pnpm benchmark run --runs 3                            # 跑全部任务各 3 次
pnpm benchmark dashboard --dir benchmark/results       # 聚合仪表盘
pnpm benchmark dashboard --badge                       # 输出 shields.io 徽章 URL
```

常用参数：

| 参数 | 说明 |
|------|------|
| `--task <id>` | 只跑指定任务 |
| `--profile <name>` | 使用的 profile（默认 `full`） |
| `--runs <n>` | 每任务运行次数（默认 3） |
| `--output <path>` | 结果 JSON 输出路径 |
| `--dir <path>` / `--out <path>` / `--badge` | dashboard 专用 |

需要配置好 provider 与 API key（见[快速开始](./quickstart.md)）。**任务全部本地执行，不依赖互联网。**

## 内置任务

| 任务 | 类别 | 难度 | 说明 |
|------|------|------|------|
| `single-file-bug-001` | 单文件 bug 修复 | easy | 修 `src/utils.ts` 的 off-by-one |
| `multi-file-bug-001` | API 契约不匹配 | medium | `renderProfile()` 用了 `data.name`，应为 `data.fullName` |
| `long-horizon-001` | 长程调试 | hard | `discountTotal()` 在折扣超过总额时返回负值，测试期望 0 |
| `cascading-fix-001` | 级联修复（recovery） | hard | 3 个独立 bug 分布在 3 个文件，每跑一次测试才暴露下一个 |
| `feature-spec-001` | 功能实现 | hard | 按规格实现任务管理 API（校验/权限/缓存/审计/CSV 导出） |

每个任务由 `task.yaml` 描述（`repository` / `setup` / `verify` / `success_criteria`），setup 脚本会在临时副本里重建仓库，因此**可重复执行**。

## 记录的指标

单次 run（`benchmark/results/*.json` 的 `results[]`）：

`success` / `duration_ms` / `turns` / `tool_calls` / `tool_errors` / `retries` / `compactions` / `stop_reason` / `failure_reason` / `checks_passed` / `checks_failed` / `harness_error` / `verification_skipped`，以及完整 `events` 数组（可还原逐工具轨迹）。

仪表盘聚合（`pnpm benchmark dashboard`）：

- 成功率
- 平均 token
- **空响应率** —— 思考吃满 `max_tokens` 导致模型什么也没输出
- **工具泄漏率** —— 模型把工具调用写成了纯文本，工具从未真正执行
- 框架故障率（`harness_broken`）与验证跳过率（`verification_skipped`）

后两条是本项目最典型的「不报错的故障」，此前没有任何聚合口径能看见它们。

## 判据的边界（重要）

- **空响应**不用「输出 token < N」判定：合法短答（如「1+1 答 2」）输出天然极少，区分它需要任务复杂度信息，客户端拿不到。
- **工具泄漏**只匹配尖括号标签形态、不匹配裸词：裸词字面写在本仓文档里，agent 复述会误报。
- **框架故障 ≠ 模型失败**：`harness_error` 表示执行环境坏了（测试文件缺失、模块解析失败、命令找不到），**不可计入模型能力**。

## ⚠️ 历史结果不可引用

`benchmark/results/` 下的历史数字混着**框架缺陷期**的样本——最典型的是 D1：`runner.ts` 把「置为只读」误写成 `rmSync(file, { mode: 0o444 })`，而 `rmSync` 根本没有 `mode` 选项，这段代码实际在**删除**测试文件，于是 verify 的 `npx vitest run` 因 `No test files found` 恒失败——**改对了也是失败**。

在那次修复之前，仪表盘把这类样本记成了「模型成功率」。

> **结论：D1 修复并重跑之前的成功率数字全部不可引用。** 任何对外的能力结论必须来自修复后的重新实跑。

完整的 6 个框架缺陷（现象 / 根因 / 实证 / 修复）见 [`benchmark/HARNESS-AUDIT.md`](../../benchmark/HARNESS-AUDIT.md)。

## 夜间采集

`.github/workflows/reliability.yml` 定时 + 手动触发，跑 benchmark 与 dashboard 并留 artifact。两个刻意的守卫：

- **无 API key 时整体跳过而不报错** —— fork 一定有这个 workflow 但拿不到上游 secret，不做门卫就会每天在所有 fork 上红一次。
- 只聚合**本轮**结果，不跨代混算整个 `results/` 目录。

## 关于 token 数

Step 三协议的 `reasoning_tokens` 恒为 0，思考消耗不可观测；实测中 provider 上报的 `input / output / total` 会出现彼此矛盾的情况。

因此：**仪表盘可以显示 token，但对外的能力叙事不要依赖它**，也不要用它估算成本。拿不到可靠数字时，本项目选择不发布，而不是编一个。
