import type { RawEvent, RunResult } from '../runner.js';

/**
 * Validation-loop 后验指标（只读分析，不参与 runner / reporter 的任何路径）。
 *
 * 来源：feature-spec-001 Full Profile 5-run observational analysis（2026-09-05 封板）。
 * 这些指标刻画 agent 的 evidence-driven validation loop 是否单调收敛，用于
 * timeout 关联性研究的候选 fingerprint。当前全部为 behavioral association，
 * 不是 timeout 判据；wall-clock 因果解释要等 stream-json 加 ts 之后才可能。
 *
 * 指标口径（与封板结论一致）：
 * - validation checkpoint：一次真实执行的 vitest（bash tool_start/tool_end 按 id 配对，
 *   命令含 `vitest run`，结果含 `Test Files` 汇总）。
 * - full-suite checkpoint：checkpoint 中命令在 `vitest run` 之后**没有**路径参数、
 *   也没有 `-t` / `--testNamePattern` 过滤的子集。flags 与 shell 重定向（2>&1、| head）
 *   不影响判定。只有 full-suite 之间的失败数 F 才是可比口径——单文件 debug 跑、
 *   -t 过滤跑的 F 会污染 monotonicity。
 * - regression_count / improvement_count：相邻 full-suite checkpoint 之间 F 增 / 减的次数。
 * - monotonicity = 1 - regression_count / transition_count（checkpoint 不足 2 个时定义为 1，
 *   即「无证据表明不单调」不等于「证明单调」）。
 * - max_validation_gap：相邻 full-suite checkpoint 间的最大轮距，含「开局→首跑」与
 *   「末跑→终止」两段边缘。它是 risk signal 不是阈值：B1=28 与 B2=27 结局相反（封板反例）。
 * - final_validation_gap：最后一次任意 vitest 执行（含过滤跑）到终止的轮距。
 * - rewrite_ratio：write_file / (write_file + edit_file)。**描述性指标，不判别结局**
 *   （negative finding：B4 = 0.91 却成功），不得作为 intervention target。
 */

/** 单个 full-suite checkpoint：发生轮次 + 解析出的失败/通过/总数。 */
export interface FullSuiteCheckpoint {
  turn: number;
  failed: number;
  passed: number;
  /** 套件总测试数（底部汇总行括号内的值）；0 = 仅剩失败横幅、总数不可知。相邻 checkpoint total 不同 = agent 改了测试套件，F 不可比。 */
  total: number;
}

export interface ValidationMetrics {
  /** 总轮数（thinking_start 分界，与 runner 的 turns 口径一致）。 */
  turns: number;
  /** full-suite checkpoint 序列（F 可比口径）。 */
  fullSuiteCheckpoints: FullSuiteCheckpoint[];
  /** 任意 vitest 验证执行次数（含单文件 / -t 过滤跑）。 */
  validationExecutions: number;
  /** 相邻 full-suite checkpoint 之间 F 增加的次数。 */
  regressionCount: number;
  /** 相邻 full-suite checkpoint 之间 F 减少的次数。 */
  improvementCount: number;
  /** 1 - regression/transitions；checkpoint < 2 时为 1（证据不足按不单调处理不成立）。 */
  monotonicity: number;
  /** 相邻 full-suite checkpoint 的最大轮距（含开局→首跑、末跑→终止边缘）。risk signal，非阈值。 */
  maxValidationGap: number;
  /** 最后一次任意 vitest 执行到终止的轮距。 */
  finalValidationGap: number;
  /** write_file / (write_file + edit_file)；分母为 0 时 null。描述性指标，不判别结局。 */
  rewriteRatio: number | null;
  writeCount: number;
  editCount: number;
}

/** 命令是否为带过滤的 vitest 执行：`-t` / `--testNamePattern` 名称过滤，或 run 后跟位置参数（路径）。 */
export function isFilteredVitestRun(command: string): boolean {
  const m = /vitest\s+run\b/.exec(command);
  if (m === null) return true; // 不是 vitest run（如 vitest list）：按不可比处理
  const rest = command.slice(m.index + m[0].length);
  // 截断到管道/串联边界：`| head -30`、`&& echo` 等后续 shell 不影响 vitest 自身参数
  const cutoff = rest.search(/\||&&|;/);
  const args = (cutoff === -1 ? rest : rest.slice(0, cutoff)).trim().split(/\s+/).filter(Boolean);
  if (args.some((a) => a === '-t' || a.startsWith('--testNamePattern'))) return true;
  // 位置参数（路径过滤）：跳过 flags（-x / --x）与重定向记号（2>&1、<& 等）
  const positionals = args.filter((a) => !a.startsWith('-') && !/^\d*[<>]&?\d*$/.test(a));
  return positionals.length > 0;
}

/**
 * 从 vitest 输出解析失败/通过数。
 *
 * 解析级序（审计 ab-B2 后确定，缺一不可）：
 * 1. 先剥 ANSI 转义——bash tool_result 原文内嵌 `\x1b[...m`，会把 "10 failed" 拆成
 *    跨转义序列的两段，裸正则会在残片上误配（实测把被 `| head` 截断、根本没有
 *    汇总行的输出数出 10F）。
 * 2. 优先取**底部的 `Tests N failed | M passed (T)` 汇总行**（最后一次出现）：
 *    "Test Files 1 failed | 1 passed (2)" 的文件级计数会掩盖 "Tests 12 passed (12)"
 *    的测试级真相（debug 文件加载失败 + 正式套件全绿的场景）。
 * 3. 次选失败横幅 `Failed Tests N`（head 截断时唯一幸存的计数）。
 * 4. 全部缺失（截断过狠 / no tests）→ null，不算 checkpoint。
 * 5. 文件级 "Test Files N failed" **永不折算**为 F：文件级失败数对测试级 F 不可比，
 *    它是后验分析中全部伪 "1F" 读数的来源。
 */
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function parseTestCounts(raw: string): { failed: number; passed: number } | null {
  const s = raw.replace(ANSI_RE, '');
  // "no tests"（import 崩溃 / 测试文件被删光）：0 个测试执行，F 不可比，直接排除
  if (/no tests/i.test(s)) return null;
  // 底部测试级汇总（取最后一次出现）：
  //   "Tests 10 failed | 2 passed (12)" / "Tests 12 failed (12)" / "Tests 12 passed (12)"
  // \bTests 复数锚定避免命中文件级的 "Test Files 1 failed"——文件级失败数对测试级 F
  // 不可比（实测它是全部伪 1F 读数的来源），宁可 null 也不用它折算。
  const summaries = [...s.matchAll(/\bTests\s+(?:(\d+)\s+failed(?:\s*\|\s*(\d+)\s+passed)?|(\d+)\s+passed)(?:\s*\|\s*\d+\s+skipped)?(?:\s*\((\d+)\))?/g)];
  const last = summaries[summaries.length - 1];
  if (last !== undefined) {
    if (last[3] !== undefined) return { failed: 0, passed: Number(last[3]), total: Number(last[4] ?? 0) };
    return { failed: Number(last[1]), passed: Number(last[2] ?? 0), total: Number(last[4] ?? 0) };
  }
  // head 截断时失败横幅（测试级真值）是唯一幸存的计数；横幅无总数
  const banner = s.match(/Failed\s+Tests\s+(\d+)/);
  if (banner !== null) return { failed: Number(banner[1]), passed: 0, total: 0 };
  return null;
}

/** 按 thinking_start 把事件流切成轮次（1-based）；runner 的 turns 口径与此一致。 */
export function segmentTurns(events: readonly RawEvent[]): number {
  let turns = 0;
  for (const e of events) if (e.type === 'thinking_start') turns++;
  return turns;
}

/**
 * 从一次 run 的原始事件流计算 validation-loop 指标。纯函数，只读。
 * tool_start/tool_end 按 id 配对（bash 命令只在 start 事件上，结果只在 end 事件上）。
 */
export function computeValidationMetrics(events: readonly RawEvent[]): ValidationMetrics {
  const turns = segmentTurns(events);

  // tool_use id → { name, command, turn }（配对用）；currentTurn 单次遍历维护，避免逐事件回扫
  const openCalls = new Map<string, { name: string; command: string; turn: number }>();
  const fullSuiteCheckpoints: FullSuiteCheckpoint[] = [];
  let validationExecutions = 0;
  let writeCount = 0;
  let editCount = 0;
  let lastValidationTurn: number | undefined;
  let currentTurn = 0;

  for (const e of events) {
    if (e.type === 'thinking_start') {
      currentTurn++;
      continue;
    }
    if (e.type === 'tool_start') {
      const ev = e as { id?: string; name?: string; input?: { command?: string } };
      if (ev.id === undefined) continue;
      openCalls.set(ev.id, { name: ev.name ?? '', command: ev.input?.command ?? '', turn: currentTurn });
      if (ev.name === 'write_file') writeCount++;
      if (ev.name === 'edit_file') editCount++;
      continue;
    }
    if (e.type !== 'tool_end') continue;
    const ev = e as { id?: string; name?: string; result?: string };
    const open = ev.id !== undefined ? openCalls.get(ev.id) : undefined;
    if (open === undefined) continue;
    if (open.name !== 'bash') continue;
    if (!/vitest\s+run\b/.test(open.command)) continue;
    const counts = parseTestCounts(ev.result ?? '');
    if (counts === null) continue; // 崩溃/无汇总的执行不算 checkpoint
    validationExecutions++;
    lastValidationTurn = open.turn;
    if (!isFilteredVitestRun(open.command)) {
      fullSuiteCheckpoints.push({ turn: open.turn, failed: counts.failed, passed: counts.passed, total: counts.total });
    }
  }

  let regressionCount = 0;
  let improvementCount = 0;
  let transitions = 0;
  let maxValidationGap = 0;
  for (let i = 0; i < fullSuiteCheckpoints.length; i++) {
    const cur = fullSuiteCheckpoints[i]!;
    const prev = i > 0 ? fullSuiteCheckpoints[i - 1]! : undefined;
    if (prev !== undefined) {
      // total 不同的相邻对（agent 改了测试套件），或 total=0（横幅输出、总数不可知）：
      // F 不可比——既不计入 reg/impr，也不计入 transition 分母。不同分母上的增减是
      // 伪信号（实测 B1 在 12 测试套件上加 4 个测试后读出 3F，被旧口径当成「进步」）。
      if (cur.total !== prev.total || cur.total === 0) {
        maxValidationGap = Math.max(maxValidationGap, cur.turn - prev.turn);
        continue;
      }
      transitions++;
      if (cur.failed > prev.failed) regressionCount++;
      if (cur.failed < prev.failed) improvementCount++;
      maxValidationGap = Math.max(maxValidationGap, cur.turn - prev.turn);
    } else {
      // 边缘段：开局 → 首跑
      maxValidationGap = Math.max(maxValidationGap, cur.turn);
    }
  }
  if (fullSuiteCheckpoints.length > 0) {
    // 边缘段：末跑 → 终止
    maxValidationGap = Math.max(maxValidationGap, turns - fullSuiteCheckpoints[fullSuiteCheckpoints.length - 1]!.turn);
  } else {
    // 全程无全量验证：整个 run 就是一个 gap
    maxValidationGap = turns;
  }

  return {
    turns,
    fullSuiteCheckpoints,
    validationExecutions,
    regressionCount,
    improvementCount,
    monotonicity: transitions > 0 ? 1 - regressionCount / transitions : 1,
    maxValidationGap,
    finalValidationGap: lastValidationTurn !== undefined ? turns - lastValidationTurn : turns,
    rewriteRatio: writeCount + editCount > 0 ? writeCount / (writeCount + editCount) : null,
    writeCount,
    editCount,
  };
}

/** 从一份 benchmark 结果 JSON（{ results: RunResult[] }）计算逐 run 指标。 */
export function metricsFromReport(report: { results: RunResult[] }): Array<{ runLabel: string } & ValidationMetrics> {
  return report.results.map((r, i) => ({
    runLabel: `${r.task_id}#${r.run_index}(profile=${r.profile})`,
    ...computeValidationMetrics(r.events),
  }));
}
