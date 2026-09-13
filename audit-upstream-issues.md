# 上游 Issue 迁移审计（初稿 · 待审）

> 对象：`stepfun-ai/Step-Realtime-CLI` 全部 30 条 open issue（另有 13 条为 PR/公告混入计数）。
> 方法：逐条判定失败类是否适用于本仓（pi 线），适用者在代码中找**实现位置 + 守护测试**双向证据；不适用者归因到架构差异。
> 判据：无测试的防护标注 (no-test)；不认领"模块不存在所以没这个 bug"式功劳。
> 日期：2026-09-09 · 状态：初稿，数字未对外

## 一、可认领（本仓已防住，证据齐全）

| 上游 issue | 失败类 | 本仓证据 | README 可用文案 |
|---|---|---|---|
| #94 #80 #93 | AbortSignal listener 泄漏/累积（重试、进程等待、取消通知丢失） | `provider/retry.ts:333-349` 三态齐全（已 abort 先拒不注册/成功后摘除/once+clear）；`tools/bash.ts:153-161` 按引用摘除并有注释写明原因；`background/manager.ts:596-606` 置空断链。测试：`background.test.ts:284`、`bash.test.ts:147`、`backgroundRetention.test.ts:89,101`（堆增量断言）、`i18n.test.ts:541` | 取消与进程生命周期按引用管理，泄漏面有堆增量回归钉住 |
| #86 | 用户 hook 抛异常破坏循环一致性 | hook 为子进程隔离（`plugin/manager.ts:6`「宿主从不执行插件代码」）；`hooks/engine.ts:77-102` 超时杀树/spawn 失败/EPIPE 全 fail-open 带 notice，多 hook 互不吞。测试：`hookEngine.test.ts:73,81,90,122` | 用户 hook 崩溃不拖垮循环：进程级隔离 + fail-open + 可见告警 |
| #84 | 负 token 预算仍硬发请求（超窗必炸） | 本仓 max_tokens 为静态配置（`factory.ts:85` ← `config.ts:1333`），结构上无「窗口−prompt」负数路径；发请求前预检 `loop.ts:469-510`（真实 usage 锚定 + frameworkTokens 含 tools schema）；overflow 显式通道 `runTurn.ts:496`→`loop.ts:614-687` 收缩重试 3 次后干净报错。测试：`loopCompactionPreflight.test.ts`（含「修复前此路径永不压缩」回归）、`compaction.test.ts:172` | 超窗在发请求前被估算预检拦截并压缩；API 溢出走独立分型，不冒充瞬时故障 |
| #88 | shell 无纵深防御（破坏性命令零识别） | `tui-pi/prompts.ts:35-46` 8 类破坏性模式红色告警（合并旗标 rm -rf/sudo/curl\|sh/dd/mkfs/chmod777/裸设备/fork 炸弹）；审批展示全文命令+diff+五种决策。测试：`prompts.test.ts:23-29`（含不误伤 `npm test`/`git rm --cached` 断言） | 高危命令进审批弹窗前已静态识别并醒目分级 |
| #113 | plan 模式拒绝无结构化错误码 | **端到端已实现 PLAN_MODE_BLOCKED**：`tools/types.ts:108` errorCode 字段 → `PiChat.ts:2940` 产出 → `runTurn.ts:585` 透传 → `blocks.ts:75-80` TUI 独立配色+徽章。测试：`runTurnParallel.test.ts:183-208`、`render.test.ts:369` | 上游 #113 请求的能力已在本线完整落地 |
| #82 | 「本会话始终允许」溢出时 clear-all | 本仓批准集合键=工具名（`PiChat.ts:242`），基数被工具表上界约束，无容量阈值即无淘汰反模式；clear 仅出现在新会话/fork 的有意语义（`:2246/:2305` 注释明示）。测试：`permission.test.ts:37` | 不存在该失败模式（设计规避，非修复功劳——README 措辞按"无此问题"写） |
| #66 | CLI 数值参数 parseInt 截断 | `cli.ts` 12 个选项全 string/boolean，无 number flag；真实数值入口全串校验：`ProviderManager.ts:196-212`（双重校验）、`heapWatch.ts:41-46`、config 层 `asNumber`（`config.ts:669`）要求 typeof number | 不存在该失败模式 |

**小计：5 类实防 + 2 类设计规避 = 覆盖上游 8 条 issue。**

## 二、设计分歧（如实陈述，不写成"已修复"）

| 上游 issue | 问题 | 本仓立场 | 证据 + 残余风险 |
|---|---|---|---|
| #89 | 绝对路径绕过 workspace 边界 | 边界=权限模型（manual 审批/auto 规则/plan 硬拦），非文件系统沙箱；`fsutil.ts:4-5` 注释明示且单点收口；`permission/mode.ts:58-73`；bashWriteGuard 的 `allowRoot` 证明沙箱能力已备、刻意仅对 team worker 开（`subagent/runner.ts:44-76`） | **残余风险须写进文档**：`mode.ts:65` sessionApprovals 按工具名不按路径——一次"本会话允许 write_file"= 任意路径静默放行。定位文档必须诚实披露此项 |
| #112-FM1 的 Code Mode 语境 | exec+wait 顶层工具与幻觉工具名 | 本仓无 Code Mode 这一层（工具全量直挂），失败类仍适用→见第三节 | — |

## 三、同缺（审计的真实产出：本仓修复队列）

| # | 失败类（上游来源） | 本仓现状 | 修复方向 | 建议优先级 |
|---|---|---|---|---|
| G1 | ReDoS：模型正则卡死主线程（#90） | **已修（0.1.12, `6687763`）**：`grep.ts` 构造前双守卫（>500 字符拒 + 嵌套量词形态黑名单，fail 附改写指引与 rg 替代）；`grep.redos.test.ts` 6 用例钉住拦截面与不误伤面 | 剩余边界已在注释声明：`(a|ab)+` 等异形态不拦，若仪表盘观测到真实卡死再升级 worker 方案 | ~~P0~~ done |
| G2 | 未知工具报错无恢复信息（#112-FM1） | **已修（Unreleased）**：`index.ts` 新增 `unknownToolMessage()`——fail 时附**当前上下文实际可用**的工具清单（按 tier 过滤，experimental 关闭时不宣传拿不到的工具）+ 编辑距离/子串包含双信号给出的 nearest 候选 | 剩：仅给出候选不作自动改写（有意——误导性自动纠正比不纠正更糟） | ~~P1~~ done |
| G3 | 漂移式重复调用逃逸熔断（#112-FM2） | **已修（Unreleased）**：两处独立缺陷——(1) `roundLoop.ts` 数值量级归一，令 `2.2e10`/`2.24e10` 同桶（`3`/`30000` 不同桶），漂移式复读重新落在同一指纹；(2) 失败计数器从 `runTurn` 内建 Map 提升到 `loop.ts` 持有、跨回合累加，`tripped` 位保证同一 run 只熔断一次 | 剩：`(a\|ab)+` 类异形态正则仍不拦（同 G1 注释声明的边界） | ~~P1~~ done |
| G4 | 持久化/备份写异常静默吞（#87） | `checkpoint.ts:78` `catch{}` 注释即「静默跳过」；`PiChat.ts:873/889`、`cli.ts:829-1065` 五处 catch 零通知；读侧有测试（`store.test.ts:601`）写侧无 | 一次性 notice（会话内去重）；checkpoint 备份失败把「本次无回滚点」写进 tool_result | **P2** |
| G5 | 调度器重排延迟不可 abort（#85 同类） | `toolScheduler.ts:157-160` 裸 setTimeout 无 abort 监听——429 重排队期间取消要空等 3-12s；retry 路径同类已防（A 簇）故为孤点 | 改 `abortableSleep(delay, signal)` + 到点立即 drain；测试补「延迟期内 abort」 | **P2** |
| G6 | 成功 run 内子调用失败不可见（#112-FM3 同类） | dynamic_workflow：`runner.ts:216,229,264` 失败返 null、完成行只报 attempts（`dynamicWorkflow.ts:185`）；子 agent 路径已诚实（`spawnAgent.ts:115` + 测试） | runner 加 `agentsFailed` 计数进 meta 行与工具描述 | **P2** |
| G7 | 公共函数复制漂移（#95 同类） | JSON 安全解析 ≥11 处内联（含 `session/store.ts:391` 与 `subagent/store.ts:280` **函数体逐字相同**）；`~` 展开双份（`agentsMd.ts:94`/`skill/registry.ts:89`）；truncate 契约同构 3 份。路径解析已收口（8 工具全走 fsutil） | `tryParseJson`/`expandHome` 进 utils；两个 load 合并泛型 | P3（债务非缺陷） |

**审计顺手挖出的计划外缺陷**：
- B1 **已修（0.1.12）**：`scripts/run-step.mjs` 的 Node 回退分支原在 ESM 裸调 `require.resolve('tsx')` 必炸 ReferenceError，且手拼 file URL 缺斜杠；改为 `--import tsx` 裸说明符，bun/Node 双分支 `--version` 冒烟通过。**#113 认领现已闭环**（errorCode 端到端 + 可用启动包装）。
- B2 `bash.ts:215-216` stdout/stderr `'end'` 监听不在 cleanup 摘除面内（进程退出后自散，实害低，记录备查）。
- B3 全仓无 `listenerCount` 断言——A1 的 GUARDED 依赖 code review 纪律而非测试锁死，README 措辞降级为"设计上防住"而非"测试钉死"。

## 四、不适用（旧栈专属，零引用核实过）

#78 #29（OpenTUI/Bun/.scm）、#76（readline cooked-mode 审批）、#70 #73（local-opentui-bridge/conversation-memory）、#92（state-machine.ts）、#83（executionProfile/harness）、#85 的 agent-team.ts 本体、#87 的 memory-decision-chain 本体、#81（agent-sdk 构建）、#9（realtime-voice ASR）、#21（/theme 五主题）、#61（/swarm 命令——本仓有并行调度+团队实验，形态不同）、#67（lint 清单）——`opentui|realtime-voice|coding-bridge|state-machine|conversation-memory|agent-sdk|gateway|promptForToolApproval|tree-sitter|readline` 在本仓 src/ 全部 0 命中。
#91（覆盖工具未配置）：**对本仓部分适用**——212 测试文件/2885 用例为实数，但 vitest coverage 未接入，README 不得出现覆盖率百分比。
#108 #103：元公告，用作接管时间线素材（#103 的 explore 分支是 Ink 版，#108 即 pi 线迁移本身）。

## 五、README 数字口径（对外前必须过一遍）

- ✅ 可写："30 条上游 issue 逐条对表：5 类失败模式在 pi 线已实现等价防护（附测试）、2 类经设计规避、7 类同缺已登记为公开修复队列、14 类属旧栈专属"
- ❌ 不可写：任何"修复了上游 N 个 bug"表述（我们修的是自己队列里的）；覆盖率百分比；"官方"字样
- 同缺清单开源发布本身就是接管声明：比认领表更可信

## 六、下一步（待批）

1. ~~按优先级修 G1(ReDoS) + B1(run-step) → 各带回归测试 → 发 0.1.12~~ **done（0.1.12）**
2. ~~G2/G3 一批（反馈质量）~~ **done（Unreleased）**——G2 恢复提示（7 用例 + 3 处原测试改语义）、G3 指纹归一 + 跨回合熔断（5 + 2 用例，变异验证过）
3. G4/G5/G6（P2）：持久化静默吞错 / 调度器重排不可 abort / 工作流失败不可见
4. 修完 B1 后回复上游 #113（附 errorCode 全链路 + wrapper 链接）
5. README「迁移审计」节 + 本表精简版入 `docs/`
6. benchmark/ → 每晚可靠性仪表盘（成功率 / token / 空响应 / 工具泄漏率），README 徽章 + 周报
