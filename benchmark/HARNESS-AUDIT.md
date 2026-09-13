# Benchmark Harness Audit — 评测正确性

> 状态：**审计完成，6 项缺陷全部定位；其中 5 项已修复并实证，D3 待协议增强**
> 日期：2026-09-13
> 起因：可靠性仪表盘首次产出读数（30.3% / 50%）时，两个数字互相矛盾且都不合理，回头查评测本身。
> 结论：**在修复之前，本仓 benchmark 产出的任何成功率都不具备参考价值。** 不是模型能力问题，是评测缺陷。

---

## 0. 一句话结论

仪表盘此前显示的成功率**不是模型能力的度量**，而主要是评测框架自身缺陷的噪声。
已定位 6 个独立缺陷，其中 **D1 是致命的**（把评测用的测试文件删除掉，导致「改对了也判失败」）。
其中 5 项已修复，并以「同一个任务、同一个模型」的实跑对比给出前后数据；D3 因当前 stream-json 事件协议缺少 provider stop reason，留待协议增强。

---

## 1. 缺陷清单

| 编号 | 缺陷 | 影响 | 状态 |
|------|------|------|------|
| D1 | `rmSync(file, {mode:0o444})` **删除**了测试文件（本意是改只读权限） | **致命**：verify 恒失败，成功率无意义 | **已修 + 实证** |
| D2 | 临时目录 `bench-setup-*` 从不清理 | 每跑一次泄漏一个目录（实测累积 232 个） | **已修 + 实证** |
| D3 | `captureMetrics` 没有可从 `result` 终态事件读取的 provider stop reason 字段 | `stop_reason` 目前只能保持 `null`，无法用于失败分类 | **待后续：wire 协议未提供该字段** |
| D4 | `if (success && task.verify)` 只在使用方自报成功时才跑检查 | 进程被杀/超时时检查被跳过，`checks_*=0`，与「检查跑了但没过」无法区分 | **已修：`verification_skipped` 单列** |
| D5 | `success_criteria.max_turns` 读取后从未执行 | 回合上限写了不生效（实测 14 回合 > 声明 10） | **已修** |
| D6 | `setup.sh:10` 死代码（条件恒假），且正是调脆弱 `rm -rf` 的分支 | 冗余 + 在安全删除环境下会崩 | **已修** |

---

## 2. D1 详证（致命项）

### 症状
探针实跑 `single-file-bug-001`：agent 第 1 轮 `edit_file` 就做对了修复
（`i <= values.length` → `i < values.length`，input 逐字正确），
之后又花 17 次工具调用自查（glob 找测试、写临时 `verify.ts`、跑通、删掉），
最终 `success: false`。

### 根因
`benchmark/runner.ts` 的 `executeSetup` 尾部：

```ts
// 注释：Make test files read-only so the agent cannot mutate them to fake success.
for (const file of testFiles) {
  if (existsSync(file)) {
    try { rmSync(file, { mode: 0o444, recursive: false }); } catch { /* ignore */ }
  }
}
```

`rmSync` 的选项只有 `recursive` / `force` / `maxRetries` / `retryDelay`，**没有 `mode`**。
`mode` 被静默忽略，`rmSync` 于是执行了它的本职：**删除文件**。

已实证：

```
before: ...\repo\src\utils.test.ts exists= true
after : exists= false
```

### 后果链

1. `setup.sh` 刚 `git commit` 进去的 `src/utils.test.ts` 被删
2. agent 面对一个**没有任何测试的仓库** → 只能自己写临时脚本自查
3. verify 执行 `npx vitest run` → `No test files found, exiting with code 1`
4. `executeCheck` 的 `catch { return false }` 吞掉异常 → 检查判失败
5. `success = success && checksFailed === 0` → **改对了也是 false**

关键：**这个失败与模型无关**。同一个模型无论表现多好，只要它不主动重建一个测试文件，就永远失败。

### 修复前后实跑对比（同一任务 `single-file-bug-001`、同一模型）

| 指标 | 修复前 | 修复后 | 说明 |
|------|--------|--------|------|
| 成功率 | **0%** | **100%** | 决定性差异 |
| 回合数 | 14 | **7** | 模型不再需要「找测试」 |
| 工具调用 | 18 | **9** | — |
| 时长 | 128s（超时被杀） | **30s** | — |
| 最终验证动作 | 无（进程被杀） | **`npx vitest run`** | 干净、不装依赖 |
| `checks_passed` | 0 | **1** | verify 真正执行了 |
| `harness_error` | — | `null` | 无框架故障 |

---

## 3. 修复

### D1：`rmSync` → `chmodSync`
```ts
for (const file of testFiles) {
  if (existsSync(file)) {
    try { chmodSync(file, 0o444); } catch { /* Windows 上可能无效，忽略 */ }
  }
}
```

### 附带的路径核实
Node 的模块向上查找规则使任务 repo **无需安装依赖**即可解析到父仓的 vitest：
任务 repo 位于 `benchmark/tasks/.../repo`，在项目树内，`npx vitest run` 会一路上溯到
`./node_modules`。已实证：修复 bug 后实测 `exit_code: 0` + stdout 含 `1 passed` + stderr 无 `FAIL`
——**三项断言全部满足**。

### 追加修复：`linkParentDeps()`
虽然向上解析可用，但**模型看不见这一点**——实测它执行 `ls node_modules/.bin/vitest`
得到 "vitest not found"，据此判断「依赖没装」而去跑 `npm install`（无网络下必然失败），
白扔 3–4 个回合。现在把父仓 `node_modules` 以 junction 挂进任务 repo，
使其行为与一个正常安装过的项目一致。实证：工具调用 11 → 9，找测试的 glob 次数 3 → 2。

### D2：补 finally 清理
```ts
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
```
实证：`before=232 → after=232`，泄漏归零。已清理 232 个历史残留 + 4 个 stale repo。

### D3/D4/D5：判定口径
- `executeCheck` 区分「断言未通过」（正常评测结果）与「命令没跑起来」（环境故障），
  后者标 `harness_error: 'verify_exec_error'`
- agent 未自报成功时标独立的 `verification_skipped: true`（这是运行/模型失败，**不是** harness_error，避免超时被伪装成环境坏）
- `success` 现在要求三条同时成立：agent 自报成功 + 检查全过 + 回合未超 `max_turns` + 无框架故障
- 仪表盘分别新增 `harness_broken` / `harness_broken_rate` 与
  `verification_skipped` / `verification_skipped_rate`；存在框架故障时 Markdown 顶部给警告
- 判据抽到纯函数模块 `benchmark/harnessFailure.ts`，双向变异验证：
  放宽 → 6 例误判变红；收紧 → 8 例漏判变红

### D6：删死代码
```bash
# 修复前
else
  if [ -d "$REPO/.git" ]; then find ... -exec rm -rf {} +; else rm -rf "$REPO"; fi   # 条件恒假
  mkdir -p "$REPO/src"
fi
# 修复后
else
  mkdir -p "$REPO/src"
fi
```

### D7（追加发现）：`cli.ts` 复制粘贴残留
`benchmark/cli.ts` 有 3 处重复（import ×2、usage 行 ×2、`case 'dashboard'` ×2），
另有一处把 `loadTasks` 的 DEBUG 日志块整段复制进了 `parseYamlTask`。全部清理，
并把 DEBUG 日志移除（它会往 stderr 刷无关噪音、干扰结果解析）。

---

## 4. 措辞约束（延续既有定位红线）

- **D1 修复前 `benchmark/results/` 下 281 次历史运行的成功率全部不可引用**。
  这些数字混着「测试文件被误删」这一框架缺陷，不是模型能力。
- 不得说「修复了 N 个上游问题」——这些是**本仓自己的**评测框架缺陷。
- 不得用百分比描述覆盖率。
- 不得从单任务单次运行的成功率推任何结论（n=1）。
- 可靠性仍是唯一头条轴；成本/省钱角度不写。
- 引用可靠性数字时必须同时给出 `harness_broken`，让读者知道分母里有多少是坏的。

---

## 5. 后续

- **重跑干净基线**：D1 修复后需重跑全部 5 个任务才能得到可信数字。
  当前 `benchmark/results/` 里的 `baseline-probe-*.json` / `fixed-probe-*.json` 只是验证性探针（n=1），
  不具备统计意义，不应作为基线发布。
- **D3 仍待处理**：当前 `stream-json` 的 `result` 事件只提供 agent 终态 `subtype`，不携带 provider `stop_reason`；需要扩展事件协议或从 `turn.issue`/usage 事件补齐，不能把 `result.subtype` 冒充 stop reason。`agentSucceeded` 已用 `result.subtype === 'success'` 单独判定，不受此限制。
- **G4–G6（P2 审计项）**：持久化静默失败、`toolScheduler` 不可中断重排、dynamic_workflow 隐藏失败子 agent。
