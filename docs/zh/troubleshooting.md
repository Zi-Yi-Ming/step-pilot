# 故障排查

> 按现象归类。每条都给出「症状 → 原因 → 处理」，原因尽量指向真实模块而不是猜测。

## 安装与启动

### 提示缺少模块 / `Cannot find module`

**症状**：SEA 单文件可执行版运行时报缺模块。

**原因**：单文件形态把运行时和代码打包在一起，不依赖同级文件。报这个错说明下载或重命名时文件被截断了。

**处理**：重新下载，并用随包提供的 `.sha256` 校验完整性。

### Windows SmartScreen 拦截

**症状**：下载的可执行文件被 SmartScreen 警告。

**原因**：产物未做代码签名，Windows 对下载量少的程序会警告。

**处理**：先用 `.sha256` 校验文件完整性，确认无误后选择「仍要运行」。

### 启动即退出 / 提示 Node 版本

**症状**：报引擎版本不满足。

**原因**：要求 Node.js **≥ 22**（`glob` 工具用到 `node:fs.globSync`，Node 22 起可用）。

**处理**：升级 Node，或改用 Releases 里的独立可执行文件。

## 模型接入

### 命令没有任何输出（空响应）

**症状**：模型看似在思考，最后什么也没返回。

**原因**：思考把 `max_tokens` 吃满了，输出被截断。这是本项目最典型的「不报错故障」之一。仪表盘里的**空响应率**就是它的聚合口径。

**处理**：调大 `max_tokens`，或降低思考档位（`[thinking] default_level`）。注意 Step 三协议的 `reasoning_tokens` 恒为 0，思考消耗**不可观测**，只能靠现象判断。

### 模型把工具调用写成了纯文本，工具从未执行

**症状**：回复里出现了 `<tool_name>` 这样的文本，但工具没有真正跑。

**原因**：工具泄漏（tool leak）。小模型常见的指令遵循问题。

**处理**：这是 harness 要解决的问题而非配置问题；可用 `pnpm benchmark dashboard` 观察**工具泄漏率**判断改善程度。

### 思考档位调了没效果

**症状**：改了思考参数但模型行为没变。

**原因**：阶跃三协议的思考参数名与嵌套层级各不相同（anthropic 通道要用 `output_config.effort`，不是顶层 `effort`、也不是 `thinking.budget_tokens`——后两者会被静默忽略）。详见[配置](./configuration.md)与 `src/provider/step/stepCommon.ts`。

## Shell 与命令执行

### Windows 上 bash 命令全部失败

**症状**：`bash` 工具报没有可用 shell。

**原因**：探测链是「PATH 中的 bash（排除 WSL 启动器）→ 从 git 推断 Git Bash → 注册表推断 → WSL → busybox → PowerShell」，**不回退 cmd.exe**（cmd 不认 Unix 语法，兜底到它是「能跑但全错」）。

**处理**：安装 Git for Windows 以获得 Git Bash。可用 `STEP_SHELL_PATH` 显式指定解释器路径。

### 工作区里多出一个叫 `nul` 的空文件

**症状**：仓库根目录出现 0 字节的 `nul`。

**原因**：Windows 下 `> nul` 重定向被当成了文件名。

**处理**：`nul` 是 Windows 保留设备名，普通 `rm` 删不掉。它已被加入 `.gitignore`；代码里应改用 `> /dev/null`。

## 权限

### 写文件或跑命令被拦下

**症状**：操作没有执行，提示需要确认。

**原因**：权限三档——`manual`（默认较严）、`auto`（写文件放行、bash 需确认）、`yolo`（全部放行）。plan 模式会硬拦所有写与执行类工具。

**处理**：启动时用 `-y/--yolo` 或 `--auto`；或在配置里调整权限模式。**不要把安全机制当成障碍绕过**——高风险命令（`rm`、`git reset --hard`、`curl | sh` 等）默认要求确认是有意为之。

## 上下文

### 长任务后期模型「忘了」前面的事

**症状**：对话很长之后，模型开始忽略早先的约束。

**原因**：上下文压缩已经发生（默认 75% 触发），旧内容被摘要替代。

**处理**：这是预期行为而非缺陷。可调整压缩触发阈值，或把关键约束写进 `AGENTS.md`（会被加载）。用 `pnpm benchmark dashboard` 观察压缩次数。

### grep 报「pattern 不合规」

**症状**：grep 工具拒绝执行并给出改写建议。

**原因**：两道 ReDoS 守卫——pattern 超过 500 字符、或命中「组内量词 + 组外量词」形态时会被拦下。这是形态启发式，不是通用 ReDoS 解法。

**处理**：按提示收窄 pattern，或改用 `bash` 调 `rg`。

## 会话与轨迹

### 恢复会话后状态不对

**症状**：resume 之后上下文与预期不符。

**原因**：快照是检查点、`wire.jsonl` 是事实源；若日志有损坏行或缺号，恢复时会跳过并计数。

**处理**：用 `step mission status` 或会话状态查看是否有 `warning:` 行（损坏行 / 非法迁移 / 序号缺口都会被显式暴露，不会静默吞掉）。

### Mission 事件和会话事件混在一起

**症状**：找不到某类事件。

**原因**：两者事实源**刻意分开**——会话用 `wire.jsonl`，Mission 用 `~/.step-pilot/missions/<repo 桶>/<missionId>.events.jsonl`。混写会污染会话恢复。

## Benchmark

### 成功率忽高忽低，或 verify 恒失败

**原因**：先确认是不是框架故障。`harness_error` 表示执行环境坏了（测试文件缺失、模块解析失败、命令找不到），**不是模型没做对**。

**处理**：查 `harness_broken` 指标与 [`benchmark/HARNESS-AUDIT.md`](../../benchmark/HARNESS-AUDIT.md)。另外注意：**D1 修复之前的历史成功率数字全部不可引用**。

### 夜间工作流每天在 fork 上变红

**原因**：reliability 工作流在无 API key 时会整体跳过而不报错；若仍然变红，检查 secret 配置。

## 还是解决不了

开 issue 时请附上：

- `step-pilot --version`（或 `package.json` 的 version）
- 操作系统与 Node 版本
- 复现步骤
- 相关日志（`~/.step-pilot/` 下的日志，注意**先脱敏**，不要贴 API key）

安全相关问题请看 [`SECURITY.md`](../../SECURITY.md)。
