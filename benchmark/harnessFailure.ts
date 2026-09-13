/**
 * 评测框架故障判定 —— 纯函数模块。
 *
 * 存在的唯一理由：把「环境坏了」和「模型做错了」这两件性质完全不同的事，
 * 在读数上分开。在抽出本模块之前，`executeCheck` 用 `catch { return false }`
 * 把所有异常压成同一个 `false`，于是两者在仪表盘上不可区分。
 *
 * 代价是实测过的（见 benchmark/HARNESS-AUDIT.md D1）：`rmSync(file,{mode:0o444})`
 * 误删了评测用的测试文件（本意是改只读权限），verify 因「找不到测试文件」恒失败，
 * 而仪表盘把它记成「模型成功率 50%」——一个纯粹的框架 bug 被当成了模型能力。
 *
 * 无 IO、无副作用、与 roundLoop.ts / dashboard.ts 同风格。
 */

/**
 * 环境故障的特征串。命中即判定该次 verify 的执行环境坏了，而非断言未通过。
 *
 * 每条都对应一次实测踩到的坑，不是为了穷举而穷举：
 * - `No test files found`：D1 误删测试文件后 vitest 的退出语（可直接复现）
 * - `Cannot find module`：模块解析失败（依赖没装 / 路径写错）
 * - `UNRESOLVED_IMPORT`：vite 的同类报错，措辞不同所以单列
 * - `Startup Error`：vitest/vite 配置加载阶段就挂了，测试根本没开始跑
 * - `command not found` / `is not recognized`：shell 找不到可执行文件
 *   （后者是 Windows 的措辞，两者都要收，否则跨平台判定不一致）
 * - `ENOENT`：路径不存在，通常是 setup 没生成出预期结构
 *
 * 不用「非零退出码即框架故障」这类宽口径：断言未通过同样是非零退出码，
 * 那是**正常的评测结果**，把它判成框架故障会把真实失败洗白成「环境问题」，
 * 是比原缺陷更严重的错误方向。
 */
const HARNESS_ERROR_PATTERN =
  /No test files found|Cannot find module|UNRESOLVED_IMPORT|Startup Error|command not found|is not recognized|ENOENT/i;

/**
 * 判定一段 verify 的失败输出是否属于环境故障。
 *
 * @param output 失败命令的 stdout + stderr 合并文本
 * @returns true = 环境故障（不可计入模型能力统计）；false = 断言未通过（正常评测结果）
 */
export function isHarnessFailure(output: string): boolean {
  return HARNESS_ERROR_PATTERN.test(output);
}

/** verify 的执行结果，区分「断言未通过」与「命令本身没跑起来」。 */
export interface CheckOutcome {
  /** 检查类型名（对应 task.yaml 的 verify[].type）。 */
  name: string;
  /** 是否通过。 */
  passed: boolean;
  /** 非 null 表示是环境故障，值为简短分类；null 表示无框架故障。 */
  harnessError: string | null;
}
