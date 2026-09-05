import { describe, expect, it } from 'vitest';
import { decomposeWallClock } from '../../benchmark/analysis/wallClock.js';
import type { RawEvent } from '../../benchmark/runner.js';

/**
 * 合成事件流的最小构造器：v4 stamped 形态（mono 必带；turn 与 thinking_start 计数
 * 一致——模块内部也按此口径派生，fixture 里的 turn 字段仅供人读对照）。
 */
type E = Record<string, unknown>;
const ev = (type: string, mono: number, extra: E = {}): E => ({ type, mono, ts: 1000 + mono, ...extra });
const stream = (type: string, mono: number, extra: E = {}): E => ev(type, mono, extra);
const toolStart = (id: string, mono: number, command?: string, name = 'bash'): E =>
  ev('tool_start', mono, { id, name, input: command !== undefined ? { command } : {} });
const toolEnd = (id: string, mono: number, name = 'bash'): E => ev('tool_end', mono, { id, name, result: 'ok', isError: false });
const asRaw = (events: E[]): RawEvent[] => events as unknown as RawEvent[];

describe('wall-clock decomposition（Phase B 冻结口径）', () => {
  it('单一 model gap：一个 STREAM 连续段 = 一个 model 窗口，末尾流未闭合按 EOF 闭合', () => {
    const events = [stream('thinking_start', 0), stream('thinking_delta', 100), stream('text', 500)];
    const d = decomposeWallClock(asRaw(events));
    expect(d.status).toBe('ok');
    expect(d.totalElapsedMs).toBe(500);
    expect(d.modelMs).toBe(500); // [0, 500]，EOF 闭合
    expect(d.modelWindows).toEqual([{ startMono: 0, endMono: 500, durationMs: 500, turn: 1 }]);
    expect(d.toolMs).toBe(0);
    expect(d.testMs).toBe(0);
    expect(d.otherMs).toBe(0);
  });

  it('单一 tool gap：tool_start → tool_end，非 vitest 命令归 tool', () => {
    const events = [
      stream('thinking_start', 0),
      stream('text', 100),
      toolStart('a', 200, 'ls -la'),
      toolEnd('a', 400),
    ];
    const d = decomposeWallClock(asRaw(events));
    expect(d.modelMs).toBe(100); // [0,100] 流窗口，闭合于最后一个 STREAM 事件
    expect(d.toolMs).toBe(200); // [200,400]
    expect(d.toolWindows[0]).toMatchObject({ category: 'tool', name: 'bash' });
    expect(d.otherMs).toBe(100); // [100,200] 流末→tool_start 调度间隙
  });

  it('vitest/bash gap：命令含 vitest run 归 test，与普通 bash 同轮并存', () => {
    const events = [
      stream('thinking_start', 0),
      stream('text', 100),
      toolStart('v', 200, 'cd repo && npx vitest run 2>&1 | head -30'),
      toolEnd('v', 900),
      toolStart('b', 950, 'cat package.json'),
      toolEnd('b', 1000),
    ];
    const d = decomposeWallClock(asRaw(events));
    expect(d.testMs).toBe(700); // [200,900]
    expect(d.toolMs).toBe(50); // [950,1000]
    expect(d.toolWindows.map((w) => w.category)).toEqual(['test', 'tool']);
  });

  it('model → tool → result 全链：usage 是轮末标记，result 前 teardown 归 other', () => {
    const events = [
      stream('thinking_start', 0),
      stream('tool_args_delta', 300),
      toolStart('a', 320, 'ls'),
      toolEnd('a', 600),
      ev('usage', 610, { totalTokens: 100, billedDelta: 50 }), // 轮末标记
      stream('thinking_start', 650),
      stream('text', 1000),
      ev('result', 1100, { subtype: 'success' }),
    ];
    const d = decomposeWallClock(asRaw(events));
    // turn1 model [0,300] + tool [320,600]；turn2 model [650,1000]；teardown [1000,1100] → other
    expect(d.perTurn).toEqual([
      { turn: 1, modelMs: 300, toolMs: 280, testMs: 0 },
      { turn: 2, modelMs: 350, toolMs: 0, testMs: 0 },
    ]);
    expect(d.modelMs).toBe(650);
    expect(d.toolMs).toBe(280);
    expect(d.otherMs).toBe(1100 - 0 - 650 - 280); // 20(300→320) + 10(600→610) + 40(610→650) + 100(teardown) = 170
    expect(d.coveragePct).toBeCloseTo(((650 + 280) / 1100) * 100);
  });

  it('turn boundary：多轮 per-turn 归集与轮次号一致（含被杀 run 末轮无 usage 的形态）', () => {
    const events = [
      stream('thinking_start', 0), stream('text', 100),
      ev('usage', 120),
      stream('thinking_start', 200), stream('thinking_delta', 300), stream('thinking_end', 400),
      ev('usage', 420),
      stream('thinking_start', 500), stream('text', 700), // 末轮被杀：无 usage
    ];
    const d = decomposeWallClock(asRaw(events));
    expect(d.perTurn).toEqual([
      { turn: 1, modelMs: 100, toolMs: 0, testMs: 0 },
      { turn: 2, modelMs: 200, toolMs: 0, testMs: 0 },
      { turn: 3, modelMs: 200, toolMs: 0, testMs: 0 }, // EOF 闭合 [500,700]
    ]);
    expect(d.modelMs).toBe(500);
  });

  it('turn=0：首轮 thinking_start 之前的 meta 事件（notice）不改变 phase，间隙归 other', () => {
    const events = [
      ev('notice', 0, { message: 'early meta' }), // turn=0
      ev('session.resume_hint', 50, { session_id: 's' }),
      stream('thinking_start', 200),
      stream('text', 400),
    ];
    const d = decomposeWallClock(asRaw(events));
    expect(d.modelMs).toBe(200); // [200,400]
    expect(d.otherMs).toBe(200); // [0,200] turn=0 间隙
    expect(d.perTurn).toEqual([{ turn: 1, modelMs: 200, toolMs: 0, testMs: 0 }]);
  });

  it('unknown gap：marker→marker 的长间隙留在 other，不强行归类', () => {
    const events = [
      stream('thinking_start', 0),
      stream('text', 100),
      ev('usage', 120),
      ev('turn_done', 800), // usage→turn_done 680ms 无法可靠归类
      ev('result', 900, { subtype: 'success' }),
    ];
    const d = decomposeWallClock(asRaw(events));
    expect(d.modelMs).toBe(100);
    expect(d.otherMs).toBe(800); // [100,900] 全部残差
    expect(d.coveragePct).toBeCloseTo((100 / 900) * 100);
  });

  it('mono 非单调：上报 anomaly 且 monotonicityViolated=true，不静默修正', () => {
    const events = [
      stream('thinking_start', 0),
      stream('text', 100),
      stream('thinking_start', 50), // 回跳
      stream('text', 200),
    ];
    const d = decomposeWallClock(asRaw(events));
    expect(d.monotonicityViolated).toBe(true);
    expect(d.anomalies.some((a) => a.includes('mono 非单调'))).toBe(true);
    expect(d.totalElapsedMs).toBe(200); // 按原始数据计算，不修正
  });

  it('最终 result：成功 run 的 result/turn_done 是边界标记，只闭合窗口不计时长', () => {
    const events = [
      stream('thinking_start', 0),
      stream('text', 500),
      ev('turn_done', 520),
      ev('result', 600, { subtype: 'success', durationMs: 600 }),
    ];
    const d = decomposeWallClock(asRaw(events));
    expect(d.modelMs).toBe(500);
    expect(d.otherMs).toBe(100); // teardown
    expect(d.totalElapsedMs).toBe(600);
  });

  it('子 agent 事件 phase 中性：落在 tool 窗口内不改变归因，落在窗口外归 other', () => {
    const events = [
      stream('thinking_start', 0),
      stream('text', 100),
      toolStart('spawn', 150, undefined, 'spawn_agent'),
      ev('subagent.start', 200, { subagent_id: 'sa1', subagent_type: 'explore', description: 'd' }),
      ev('subagent.tool', 300, { subagent_id: 'sa1', name: 'read_file' }),
      ev('subagent.end', 400, { subagent_id: 'sa1', is_error: false }),
      toolEnd('spawn', 500, 'spawn_agent'),
    ];
    const d = decomposeWallClock(asRaw(events));
    expect(d.toolMs).toBe(350); // [150,500] spawn_agent 窗口整体
    expect(d.modelMs).toBe(100);
    expect(d.otherMs).toBe(50); // [100,150]
  });

  it('retry：retry → 下一 STREAM 事件归 wait（退避），usage 计数缺末轮不炸', () => {
    const events = [
      stream('thinking_start', 0),
      stream('text', 100),
      ev('retry', 200, { attempt: 1, delayMs: 3000, message: 'r' }), // 退避
      stream('thinking_start', 3600), // 重发（真实数据中 retry 恒紧邻 thinking_start）
      stream('text', 3800),
    ];
    const d = decomposeWallClock(asRaw(events));
    expect(d.waitMs).toBe(3400); // [200,3600]
    expect(d.modelMs).toBe(100 + 200); // [0,100] + [3600,3800]
    expect(d.waitWindows[0]).toMatchObject({ reason: 'retry_backoff' });
  });

  it('并行工具窗口重叠：并集去重，不双计', () => {
    const events = [
      stream('thinking_start', 0),
      stream('text', 100),
      toolStart('a', 200, 'ls'),
      toolStart('b', 300, 'pwd'), // b 在 a 执行期间启动
      toolEnd('a', 500),
      toolEnd('b', 700),
    ];
    const d = decomposeWallClock(asRaw(events));
    expect(d.toolMs).toBe(500); // 原始窗口和 = 300+400 = 700？不——并集 [200,700] = 500
    expect(d.otherMs).toBe(100); // [100,200]
    expect(d.totalElapsedMs).toBe(700);
  });

  it('no-timing-data：v3 形态（无 mono 字段）返回 status=no-timing-data，只报 anomaly', () => {
    const events = [{ type: 'thinking_start' }, { type: 'text' }];
    const d = decomposeWallClock(asRaw(events));
    expect(d.status).toBe('no-timing-data');
    expect(d.totalElapsedMs).toBeNull();
    expect(d.modelMs).toBe(0);
    expect(d.anomalies[0]).toContain('no timing fields');
  });

  it('tool 未配对：EOF 悬空 tool_start 与孤立 tool_end 都上报 anomaly，不产窗口', () => {
    const events = [
      stream('thinking_start', 0),
      stream('text', 100),
      toolStart('orphan', 200, 'ls'),
      toolEnd('ghost', 300),
      stream('text', 400),
    ];
    const d = decomposeWallClock(asRaw(events));
    expect(d.toolMs).toBe(0);
    expect(d.anomalies.some((a) => a.includes('未配对到 tool_end'))).toBe(true);
    expect(d.anomalies.some((a) => a.includes('无配对 tool_start'))).toBe(true);
  });

  it('tool 窗口 mono 回跳：窗口丢弃并上报，不产负时长', () => {
    const events = [
      stream('thinking_start', 0),
      stream('text', 100),
      toolStart('a', 500, 'ls'),
      toolEnd('a', 300), // 回跳
    ];
    const d = decomposeWallClock(asRaw(events));
    expect(d.toolMs).toBe(0);
    expect(d.anomalies.some((a) => a.includes('tool 窗口异常'))).toBe(true);
    expect(d.monotonicityViolated).toBe(true);
  });
});
