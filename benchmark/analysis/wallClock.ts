import type { RawEvent } from '../runner.js';

/**
 * 步骤③：wall-clock decomposition（纯分析层，不进入任何运行时路径）。
 *
 * 回答：一个 run 的 wall-clock budget 花在了哪里。归因状态机在 Phase B 冻结，
 * 全部边界依据真实事件流核实（2026-09-05，10 个 baseline run）：
 * - `usage` 恒紧邻在 `tool_end` 之后、`thinking_start` 之前——它是**轮末标记**，
 *   不是 model 调用结束标记；工具执行夹在模型流结束与 usage 之间。
 * - `retry` 恒紧邻在 `thinking_start` 之前——新尝试自带轮标记，retry 到下一
 *   STREAM 事件之间是退避等待。
 * - 被杀 run 的 usage 计数 < thinking_start 计数（末轮无 usage），因此 model
 *   窗口的闭合不能依赖 usage，只能依赖「STREAM 连续段结束」。
 *
 * 时间规则：duration 一律用 `mono`（performance.now，单调）；`ts` 仅用于绝对
 * 时间展示与 sanity check，禁止 `ts_end - ts_start` 作正式 duration。mono 非单调
 * 必须上报 anomaly，不得静默修正。
 *
 * 归因不强行凑满 100%：所有无法可靠归类的间隙（流末→tool_start 的调度、
 * tool_end→usage 收尾、usage→thinking_start 循环开销、teardown、turn=0 间隙）
 * 一律留在 `other`，并给出 coverage 让读者看到归因覆盖率。
 */

/** 五个归因类别。other 是残差桶，不是第四类「已归类」。 */
export type WallCategory = 'model' | 'tool' | 'test' | 'wait' | 'other';

/** STREAM 族：模型流式响应的事件（一个连续段 = 一次 model round-trip 的流式窗口）。 */
const STREAM_FAMILY: ReadonlySet<string> = new Set([
  'thinking_start',
  'thinking_delta',
  'thinking_end',
  'text',
  'tool_forming',
  'tool_args_delta',
]);

/** bash 命令被归类为 vitest 执行的判据（与步骤① checkpoint 判据同源：命令含 `vitest run`）。 */
const VITEST_RUN_RE = /vitest\s+run\b/;

export interface ModelWindow {
  startMono: number;
  endMono: number;
  durationMs: number;
  turn: number;
}

export interface ToolWindow {
  id: string;
  name: string;
  /** test = vitest 执行窗口；tool = 其余工具执行窗口。 */
  category: 'tool' | 'test';
  startMono: number;
  endMono: number;
  durationMs: number;
  turn: number;
}

export interface WaitWindow {
  startMono: number;
  endMono: number;
  durationMs: number;
  /** 目前唯一来源：retry 退避。保留字面量便于未来扩展。 */
  reason: 'retry_backoff';
}

export interface TurnBreakdown {
  turn: number;
  modelMs: number;
  toolMs: number;
  testMs: number;
}

export interface WallClockDecomposition {
  /** ok = 有 timing 数据；no-timing-data = 事件流无 mono 字段（v3 baseline），只报 total。 */
  status: 'ok' | 'no-timing-data';
  /** 首个带 mono 的事件到最后一个带 mono 的事件。 */
  totalElapsedMs: number | null;
  modelMs: number;
  toolMs: number;
  testMs: number;
  waitMs: number;
  /** 残差：total − 已归因并集。不强行归类，见模块注释。 */
  otherMs: number;
  /** (model+tool+test+wait) / total。other 不计入分子——它表示归因覆盖率而非 100%。 */
  coveragePct: number | null;
  perTurn: TurnBreakdown[];
  modelWindows: ModelWindow[];
  toolWindows: ToolWindow[];
  waitWindows: WaitWindow[];
  /** mono 缺失 / 非单调 / tool 未配对等异常，逐条人读。 */
  anomalies: string[];
  monotonicityViolated: boolean;
  eventCount: number;
  /** 带 mono 的事件数（v3 baseline 恒为 0）。 */
  timedEventCount: number;
}

interface TimedEvent {
  type: string;
  mono: number;
  /** 按 thinking_start 计数派生的轮次（与 segmentTurns 口径一致），0 = 首轮前。 */
  turn: number;
  id?: string;
  name?: string;
  command?: string;
}

/** 从事件流提取带 mono 的样本并派生轮次；同时记录 mono 缺失情况。 */
function collectTimedEvents(events: readonly RawEvent[]): { timed: TimedEvent[]; missingMono: number } {
  const timed: TimedEvent[] = [];
  let missingMono = 0;
  let turn = 0;
  for (const e of events) {
    if (e.type === 'thinking_start') turn++;
    const mono = (e as { mono?: unknown }).mono;
    if (typeof mono !== 'number' || !Number.isFinite(mono)) {
      missingMono++;
      continue;
    }
    const te = e as { id?: unknown; name?: unknown; input?: { command?: unknown } };
    timed.push({
      type: e.type,
      mono,
      turn,
      id: typeof te.id === 'string' ? te.id : undefined,
      name: typeof te.name === 'string' ? te.name : undefined,
      command: typeof te.input?.command === 'string' ? te.input.command : undefined,
    });
  }
  return { timed, missingMono };
}

/** 区间并集总时长（处理并行工具窗口的重叠，防双计）。 */
function unionDuration(intervals: Array<{ start: number; end: number }>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = sorted[0]!.start;
  let curEnd = sorted[0]!.end;
  for (const iv of sorted.slice(1)) {
    if (iv.start > curEnd) {
      total += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    } else if (iv.end > curEnd) {
      curEnd = iv.end;
    }
  }
  return total + (curEnd - curStart);
}

/**
 * 对一份 stream-json 事件流做 wall-clock 归因。纯函数，只读。
 * 事件顺序即文件顺序（emission 顺序），mono 单调性按此顺序校验。
 */
export function decomposeWallClock(events: readonly RawEvent[]): WallClockDecomposition {
  const anomalies: string[] = [];
  const { timed, missingMono } = collectTimedEvents(events);

  const base: WallClockDecomposition = {
    status: 'ok',
    totalElapsedMs: null,
    modelMs: 0,
    toolMs: 0,
    testMs: 0,
    waitMs: 0,
    otherMs: 0,
    coveragePct: null,
    perTurn: [],
    modelWindows: [],
    toolWindows: [],
    waitWindows: [],
    anomalies,
    monotonicityViolated: false,
    eventCount: events.length,
    timedEventCount: timed.length,
  };

  if (timed.length === 0) {
    base.status = 'no-timing-data';
    if (missingMono > 0) {
      anomalies.push(`no timing fields on ${missingMono}/${events.length} events（v3 baseline 无 ts/mono，逐事件归因不可行）`);
    }
    return base;
  }

  // mono 单调性校验（按事件顺序）：允许相等（同 tick 连发），不允许下降。
  for (let i = 1; i < timed.length; i++) {
    if (timed[i]!.mono < timed[i - 1]!.mono) {
      base.monotonicityViolated = true;
      anomalies.push(
        `mono 非单调：event#${i}(${timed[i]!.type}) ${timed[i]!.mono} < 前一事件 ${timed[i - 1]!.mono}——duration 结果不可信，已上报不修正`,
      );
    }
  }

  const first = timed[0]!;
  const last = timed[timed.length - 1]!;
  base.totalElapsedMs = last.mono - first.mono;

  // --- model 窗口：STREAM 连续段 [首事件.mono → 末事件.mono] ---
  const modelIntervals: Array<{ start: number; end: number; turn: number }> = [];
  let streamOpen: TimedEvent | undefined;
  let streamLast: TimedEvent | undefined;
  for (const e of timed) {
    if (STREAM_FAMILY.has(e.type)) {
      if (streamOpen === undefined) streamOpen = e;
      streamLast = e;
      continue;
    }
    // 非 STREAM 事件 = 边界：闭合在最后一个 STREAM 事件上（流末→边界的间隙留给 other）
    if (streamOpen !== undefined && streamLast !== undefined) {
      if (streamLast.mono < streamOpen.mono) {
        anomalies.push(`model 窗口异常（turn ${streamOpen.turn}）：末 STREAM 事件 mono < 首 STREAM 事件 mono，窗口丢弃`);
      } else {
        modelIntervals.push({ start: streamOpen.mono, end: streamLast.mono, turn: streamOpen.turn });
      }
      streamOpen = undefined;
      streamLast = undefined;
    }
  }
  if (streamOpen !== undefined && streamLast !== undefined) {
    // 流到 EOF 未闭合（被杀 run 的末轮）：闭合在最后一个事件上
    modelIntervals.push({ start: streamOpen.mono, end: streamLast.mono, turn: streamOpen.turn });
  }

  // --- tool/test 窗口：tool_start(id) → tool_end(id) ---
  const openTools = new Map<string, TimedEvent>();
  const toolIntervals: Array<{ start: number; end: number; turn: number; category: 'tool' | 'test'; id: string; name: string }> = [];
  for (const e of timed) {
    if (e.type === 'tool_start') {
      if (e.id === undefined) {
        anomalies.push(`tool_start 缺 id（turn ${e.turn}），无法配对，窗口丢弃`);
        continue;
      }
      if (openTools.has(e.id)) {
        anomalies.push(`tool_start id 重复：${e.id}（turn ${e.turn}），旧窗口丢弃`);
      }
      openTools.set(e.id, e);
      continue;
    }
    if (e.type === 'tool_end') {
      const open = e.id !== undefined ? openTools.get(e.id) : undefined;
      if (open === undefined) {
        anomalies.push(`tool_end 无配对 tool_start：id=${e.id ?? '?'}（turn ${e.turn}），窗口丢弃`);
        continue;
      }
      openTools.delete(e.id);
      const category: 'tool' | 'test' = open.command !== undefined && VITEST_RUN_RE.test(open.command) ? 'test' : 'tool';
      if (e.mono < open.mono) {
        anomalies.push(`tool 窗口异常（${open.name} id=${open.id}）：tool_end mono < tool_start mono，窗口丢弃`);
        continue;
      }
      toolIntervals.push({ start: open.mono, end: e.mono, turn: open.turn, category, id: open.id!, name: open.name ?? '?' });
    }
  }
  for (const [, open] of openTools) {
    anomalies.push(`tool_start 未配对到 tool_end（EOF）：${open.name} id=${open.id}（turn ${open.turn}），窗口丢弃`);
  }

  // --- wait 窗口：retry → 下一个 STREAM 事件（退避 + 重发） ---
  const waitIntervals: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < timed.length; i++) {
    if (timed[i]!.type !== 'retry') continue;
    const next = timed.slice(i + 1).find((e) => STREAM_FAMILY.has(e.type));
    if (next === undefined) {
      anomalies.push(`retry 后无 STREAM 事件（run 末尾），wait 窗口丢弃`);
      continue;
    }
    if (next.mono < timed[i]!.mono) {
      anomalies.push(`wait 窗口异常：retry 后 STREAM 事件 mono < retry mono，窗口丢弃`);
      continue;
    }
    waitIntervals.push({ start: timed[i]!.mono, end: next.mono });
  }

  // --- 汇总：原始窗口之和（per-turn 口径）+ 并集（total 口径，防并行工具双计） ---
  base.modelWindows = modelIntervals.map((iv) => ({
    startMono: iv.start,
    endMono: iv.end,
    durationMs: iv.end - iv.start,
    turn: iv.turn,
  }));
  base.toolWindows = toolIntervals.map((iv) => ({
    id: iv.id,
    name: iv.name,
    category: iv.category,
    startMono: iv.start,
    endMono: iv.end,
    durationMs: iv.end - iv.start,
    turn: iv.turn,
  }));
  base.waitWindows = waitIntervals.map((iv) => ({
    startMono: iv.start,
    endMono: iv.end,
    durationMs: iv.end - iv.start,
    reason: 'retry_backoff' as const,
  }));

  const sumBy = (ivs: Array<{ start: number; end: number }>): number => ivs.reduce((a, iv) => a + (iv.end - iv.start), 0);
  // 类别总量按**该类窗口的并集**计（wall-clock 归因语义：并行工具的重叠执行只占墙钟一次），
  // 不用原始窗口和——重叠时它会双计（实测并行 fixture：原始和 700ms，墙钟真实占用 500ms）。
  const toolIntervalsOnly = toolIntervals.filter((iv) => iv.category === 'tool');
  const testIntervals = toolIntervals.filter((iv) => iv.category === 'test');
  base.modelMs = unionDuration(modelIntervals);
  base.toolMs = unionDuration(toolIntervalsOnly);
  base.testMs = unionDuration(testIntervals);
  base.waitMs = unionDuration(waitIntervals);

  if (base.totalElapsedMs !== null && base.totalElapsedMs >= 0) {
    const attributedUnion =
      unionDuration(modelIntervals) +
      unionDuration(toolIntervals.map((iv) => ({ start: iv.start, end: iv.end }))) +
      unionDuration(waitIntervals);
    base.otherMs = base.totalElapsedMs - attributedUnion;
    if (base.otherMs < 0) {
      anomalies.push(`残差为负（${base.otherMs.toFixed(1)}ms）：窗口并集超出 total，mono 数据存在异常，other 按负值如实上报`);
    }
    if (base.totalElapsedMs > 0) {
      base.coveragePct = ((base.modelMs + base.toolMs + base.testMs + base.waitMs) / base.totalElapsedMs) * 100;
    }
  }

  // --- per-turn：按窗口开启事件的轮次归集，类内做并集（与总量口径一致） ---
  const turnMap = new Map<number, TurnBreakdown>();
  const bump = (turn: number, field: 'modelMs' | 'toolMs' | 'testMs', ivs: Array<{ start: number; end: number }>): void => {
    if (ivs.length === 0) return;
    const row = turnMap.get(turn) ?? { turn, modelMs: 0, toolMs: 0, testMs: 0 };
    row[field] += unionDuration(ivs);
    turnMap.set(turn, row);
  };
  for (const turn of new Set([...modelIntervals, ...toolIntervals].map((iv) => iv.turn))) {
    bump(turn, 'modelMs', modelIntervals.filter((iv) => iv.turn === turn).map((iv) => ({ start: iv.start, end: iv.end })));
    bump(turn, 'toolMs', toolIntervalsOnly.filter((iv) => iv.turn === turn).map((iv) => ({ start: iv.start, end: iv.end })));
    bump(turn, 'testMs', testIntervals.filter((iv) => iv.turn === turn).map((iv) => ({ start: iv.start, end: iv.end })));
  }
  base.perTurn = [...turnMap.values()].sort((a, b) => a.turn - b.turn);

  return base;
}
