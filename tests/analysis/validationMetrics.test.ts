import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computeValidationMetrics,
  isFilteredVitestRun,
  parseTestCounts,
  segmentTurns,
} from '../../benchmark/analysis/validationMetrics.js';
import type { RawEvent } from '../../benchmark/runner.js';

/** 合成事件流的最小构造器：与 stream-json 输出的事件形状对齐（tool_start 带 id+name+input，tool_end 带 id+name+result，thinking_start 分轮）。 */
type RawEventLike = Record<string, unknown>;
function ev(type: string, extra: Record<string, unknown> = {}): RawEventLike {
  return { type, ...extra };
}

/** 生成一个 turn：thinking_start + bash(start/end)。 */
function bashTurn(id: string, command: string, result: string): RawEventLike[] {
  return [
    ev('thinking_start'),
    ev('tool_start', { id, name: 'bash', input: { command } }),
    ev('tool_end', { id, name: 'bash', result }),
  ];
}

/** 12 测试套件的底部汇总行。 */
const FULL = (f: number, p: number, total = 12) =>
  ` Test Files  1 failed (1)\n      Tests  ${f} failed | ${p} passed (${total})\n`;

describe('isFilteredVitestRun', () => {
  it('裸 run + flags + 重定向 = 全量（不判为过滤）', () => {
    expect(isFilteredVitestRun('npx vitest run')).toBe(false);
    expect(isFilteredVitestRun('npx vitest run 2>&1')).toBe(false);
    expect(isFilteredVitestRun('npx vitest run --reporter=verbose 2>&1 | head -30')).toBe(false);
    expect(isFilteredVitestRun('npx vitest run --no-cache')).toBe(false);
    expect(isFilteredVitestRun('cd repo && npx vitest run --reporter=verbose 2>&1')).toBe(false);
  });

  it('路径位置参数 = 过滤', () => {
    expect(isFilteredVitestRun('npx vitest run src/__tests__/debug.test.ts')).toBe(true);
    expect(isFilteredVitestRun('npx vitest run --reporter=verbose src/__tests__/x.ts 2>&1')).toBe(true);
  });

  it('-t / --testNamePattern 名称过滤 = 过滤（含 11 skipped 陷阱：总数 (12) 不代表全量执行）', () => {
    expect(isFilteredVitestRun('npx vitest run -t "cache miss" 2>&1')).toBe(true);
    expect(isFilteredVitestRun('npx vitest run --reporter=verbose -t "creates task"')).toBe(true);
    expect(isFilteredVitestRun('npx vitest run --testNamePattern=x')).toBe(true);
  });

  it('非 vitest run 命令（仅含 vitest 字样）按不可比处理', () => {
    expect(isFilteredVitestRun('cat vitest.config.ts')).toBe(true);
    expect(isFilteredVitestRun('npx vitest list')).toBe(true);
  });
});

describe('parseTestCounts（解析级序，全部来自 baseline 审计实证）', () => {
  it('底部测试级汇总优先：Test Files 的文件级 1 failed 不得污染 F', () => {
    // 实证：旧临时正则把 "Test Files 1 failed (1)" 当 F=1，是 B3 全部伪「回归」读数的来源
    expect(parseTestCounts(' Test Files  1 failed (1)\n      Tests  10 failed | 2 passed (12)\n')).toEqual({ failed: 10, passed: 2, total: 12 });
  });

  it('仅 failed 形态：Tests 12 failed (12) → {12,0,12}', () => {
    expect(parseTestCounts('Test Files  1 failed (1)\n Tests  12 failed (12)\n')).toEqual({ failed: 12, passed: 0, total: 12 });
  });

  it('全绿形态：Tests 12 passed (12) → {0,12,12}（文件级 1 failed 不得掩盖）', () => {
    // 实证 B2 T39：debug 文件加载失败 + 正式套件全绿
    expect(parseTestCounts('Test Files  1 failed | 1 passed (2)\n Tests  12 passed (12)\n')).toEqual({ failed: 0, passed: 12, total: 12 });
  });

  it('head 截断只剩失败横幅：Failed Tests 10 → {10,0,total=0}', () => {
    expect(parseTestCounts('npm warn ...\n ⎯ Failed Tests 10 ⎯\n × creates task 3ms\n')).toEqual({ failed: 10, passed: 0, total: 0 });
  });

  it('ANSI 转义分隔的计数照样可读', () => {
    expect(parseTestCounts('Tests  \x1b[31m10 failed\x1b[22m | \x1b[33m2 passed\x1b[22m (12)')).toEqual({ failed: 10, passed: 2, total: 12 });
  });

  it('no tests（import 崩溃）→ null；只剩文件级行 → null；空 → null', () => {
    expect(parseTestCounts('Test Files  1 failed (1)\n Tests  no tests\n')).toBeNull();
    expect(parseTestCounts('Test Files  1 failed (1)\n')).toBeNull();
    expect(parseTestCounts('')).toBeNull();
  });

  it('skipped 汇总：1 passed | 11 skipped (12) 是 -t 过滤跑的形态（命令层已排除，这里只保证可解析）', () => {
    expect(parseTestCounts('Test Files  1 passed (1)\n Tests  1 passed | 11 skipped (12)\n')).toEqual({ failed: 0, passed: 1, total: 12 });
  });
});

describe('segmentTurns', () => {
  it('thinking_start 分轮，与 runner 的 turns 口径一致', () => {
    const events = [ev('thinking_start'), ev('text'), ev('thinking_start'), ev('tool_start', { id: 'a', name: 'bash', input: {} })];
    expect(segmentTurns(events as unknown as RawEvent[])).toBe(2);
  });
});

describe('computeValidationMetrics', () => {
  it('单调收敛：10F → 1F → 0F，regression=0、improvement=2、monotonicity=1', () => {
    const events = [
      ...bashTurn('a', 'npx vitest run', FULL(10, 2)),
      ...bashTurn('b', 'npx vitest run', FULL(1, 11)),
      ...bashTurn('c', 'npx vitest run 2>&1 | head', FULL(0, 12)),
    ];
    const m = computeValidationMetrics(events as unknown as RawEvent[]);
    expect(m.fullSuiteCheckpoints).toEqual([
      { turn: 1, failed: 10, passed: 2, total: 12 },
      { turn: 2, failed: 1, passed: 11, total: 12 },
      { turn: 3, failed: 0, passed: 12, total: 12 },
    ]);
    expect(m.regressionCount).toBe(0);
    expect(m.improvementCount).toBe(2);
    expect(m.monotonicity).toBe(1);
    expect(m.maxValidationGap).toBe(1);
    expect(m.finalValidationGap).toBe(0);
  });

  it('回归循环：10F → 1F → 10F → 1F → 10F（同 total），regression=2、improvement=2、monotonicity=0.5', () => {
    const events = [
      ...bashTurn('a', 'npx vitest run', FULL(10, 2)),
      ...bashTurn('b', 'npx vitest run', FULL(1, 11)),
      ...bashTurn('c', 'npx vitest run', FULL(10, 2)),
      ...bashTurn('d', 'npx vitest run', FULL(1, 11)),
      ...bashTurn('e', 'npx vitest run', FULL(10, 2)),
    ];
    const m = computeValidationMetrics(events as unknown as RawEvent[]);
    expect(m.regressionCount).toBe(2);
    expect(m.improvementCount).toBe(2);
    expect(m.monotonicity).toBe(0.5);
  });

  it('suite 被改（total 变化）的相邻对不参与 reg/impr/mono：12t 上的 10F → 16t 上的 3F 不是进步', () => {
    // 实证 B1：在原 12 测试上改动套件后读出 3 failed | 13 passed (16)
    const events = [
      ...bashTurn('a', 'npx vitest run', FULL(10, 2)),
      ...bashTurn('b', 'npx vitest run', FULL(3, 13, 16)),
    ];
    const m = computeValidationMetrics(events as unknown as RawEvent[]);
    expect(m.regressionCount).toBe(0);
    expect(m.improvementCount).toBe(0);
    expect(m.monotonicity).toBe(1);
    expect(m.maxValidationGap).toBe(1); // 边缘段：开局→首跑 1，末跑→终止 2-1=1
  });

  it('过滤跑不进 fullSuiteCheckpoints 但计入验证执行；final gap 以最后一次任意 vitest 执行起算', () => {
    const events = [
      ...bashTurn('a', 'npx vitest run', FULL(10, 2)),
      ...bashTurn('b', 'npx vitest run src/__tests__/debug.test.ts', ' Test Files  1 failed (1)\n      Tests  1 failed | 0 passed (1)\n'),
      ...bashTurn('c', 'npx vitest run -t "cache miss" 2>&1', ' Test Files  1 passed (1)\n      Tests  1 passed | 11 skipped (12)\n'),
    ];
    const m = computeValidationMetrics(events as unknown as RawEvent[]);
    expect(m.fullSuiteCheckpoints).toHaveLength(1);
    expect(m.validationExecutions).toBe(3);
    expect(m.maxValidationGap).toBe(2); // 开局→首跑 1，末跑→终止 3-1=2
    expect(m.finalValidationGap).toBe(0);
  });

  it('无 vitest 执行：maxValidationGap = finalValidationGap = turns', () => {
    const events = [...bashTurn('a', 'echo hi', 'hi'), ...bashTurn('b', 'cat vitest.config.ts', 'cfg')];
    const m = computeValidationMetrics(events as unknown as RawEvent[]);
    expect(m.validationExecutions).toBe(0);
    expect(m.maxValidationGap).toBe(2);
    expect(m.finalValidationGap).toBe(2);
  });

  it('仅含 vitest 字样但非执行的命令不算 checkpoint', () => {
    const events = [...bashTurn('a', 'cat vitest.config.ts', 'Test Files 无关文本'), ...bashTurn('b', 'echo done', 'done')];
    const m = computeValidationMetrics(events as unknown as RawEvent[]);
    expect(m.validationExecutions).toBe(0);
  });

  it('rewrite_ratio 为描述性指标（negative finding：不判别结局），无写编时为 null', () => {
    const events = [
      ev('thinking_start'),
      ev('tool_start', { id: 'w', name: 'write_file', input: { path: 'a.ts' } }),
      ev('tool_end', { id: 'w', name: 'write_file', result: 'ok' }),
      ev('tool_start', { id: 'e', name: 'edit_file', input: { path: 'b.ts' } }),
      ev('tool_end', { id: 'e', name: 'edit_file', result: 'ok' }),
      ev('tool_start', { id: 'w2', name: 'write_file', input: { path: 'c.ts' } }),
      ev('tool_end', { id: 'w2', name: 'write_file', result: 'ok' }),
    ];
    const m = computeValidationMetrics(events as unknown as RawEvent[]);
    expect(m.writeCount).toBe(2);
    expect(m.editCount).toBe(1);
    expect(m.rewriteRatio).toBeCloseTo(2 / 3);
    expect(computeValidationMetrics([ev('thinking_start')] as unknown as RawEvent[]).rewriteRatio).toBeNull();
  });

  it('无 id 的 tool_start 被忽略，不产生幽灵配对', () => {
    const events = [
      ev('thinking_start'),
      ev('tool_start', { name: 'bash', input: { command: 'npx vitest run' } }),
      ev('tool_end', { name: 'bash', result: FULL(0, 12) }),
    ];
    const m = computeValidationMetrics(events as unknown as RawEvent[]);
    expect(m.validationExecutions).toBe(0);
  });
});

/**
 * 封板 baseline 钉值（ab-*.json 只读校验，文件缺失时跳过）。
 *
 * 注意：以下数值是**固化脚本口径下的修正值**，与 2026-09-05 人工封板分析的不同——
 * 人工分析的临时正则有三处缺陷（Test Files 文件级行污染 F、"(12)" 误配 -t 过滤跑的
 * 11-skipped 汇总、head/tail 截断下的漏检），修正后的差异已逐条对原始事件流核实：
 * - B3 reg 2→0：7 个全量 checkpoint 全部 10F，伪「1F 回归」是文件级行误读；真失败模式
 *   是 flatline（重 mutation 零进展），regression cycling 指纹作废。
 * - B5 reg 1→0：T24/T25 是 -t 过滤跑（"1 passed | 11 skipped (12)" 里的 (12) 骗过了旧正则）。
 * - B1 maxGap 28→22：T29 是 -t 过滤跑；且 T48 的 3F 发生在 16 测试套件上（agent 加了 4 个
 *   测试），不与 12 测试口径比较。
 * - B2 maxGap 27→20：旧口径漏检了 T16/T19（head 截断输出），B2 并无 27 轮静默期。
 */
describe('封板 baseline 钉值（固化口径修正版，ab-*.json 只读校验，文件缺失时跳过）', () => {
  const base = resolve(process.cwd(), 'benchmark/results');
  const load = (n: string) => JSON.parse(readFileSync(resolve(base, `ab-${n}.json`), 'utf8'));

  it('B3：regression_count = 0，flatline 指纹（8 个全量 checkpoint 全部 10F）', () => {
    if (!existsSync(resolve(base, 'ab-B3.json'))) return;
    const m = computeValidationMetrics(load('B3').results[0].events);
    expect(m.regressionCount).toBe(0);
    expect(m.monotonicity).toBe(1);
    expect(m.fullSuiteCheckpoints.length).toBeGreaterThanOrEqual(7);
    expect(m.fullSuiteCheckpoints.every((c) => c.failed === 10)).toBe(true);
    expect(m.rewriteRatio).toBeCloseTo(1.0, 2);
  });

  it('B5：final_validation_gap = 6，regression_count = 0（纯 abandonment）', () => {
    if (!existsSync(resolve(base, 'ab-B5.json'))) return;
    const m = computeValidationMetrics(load('B5').results[0].events);
    expect(m.finalValidationGap).toBe(6);
    expect(m.regressionCount).toBe(0);
    expect(m.maxValidationGap).toBe(13);
  });

  it('B1 vs B2：22 与 20 的 validation gap 结局相反（risk signal 非 threshold 的反例，修正数值版）', () => {
    if (!existsSync(resolve(base, 'ab-B1.json')) || !existsSync(resolve(base, 'ab-B2.json'))) return;
    const b1 = computeValidationMetrics(load('B1').results[0].events);
    const b2 = computeValidationMetrics(load('B2').results[0].events);
    expect(b1.maxValidationGap).toBe(22);
    expect(b2.maxValidationGap).toBe(20);
    expect(b1.regressionCount).toBe(0);
    // B1 在 T48 改了套件（12 → 16 个测试），其 3F 不与 12 测试口径比较
    expect(b1.fullSuiteCheckpoints.some((c) => c.total === 16)).toBe(true);
  });

  it('B4：成功组单调收敛，final_validation_gap = 2', () => {
    if (!existsSync(resolve(base, 'ab-B4.json'))) return;
    const m = computeValidationMetrics(load('B4').results[0].events);
    expect(m.regressionCount).toBe(0);
    expect(m.monotonicity).toBe(1);
    expect(m.finalValidationGap).toBe(2);
  });

  it('finalGap 分离（本样本）：timeout 组 ≥4，成功组 ≤3', () => {
    if (!existsSync(resolve(base, 'ab-B1.json'))) return;
    const g = (n: string) => computeValidationMetrics(load(n).results[0].events).finalValidationGap;
    expect(Math.min(g('B1'), g('B3'), g('B5'))).toBeGreaterThanOrEqual(4);
    expect(Math.max(g('B2'), g('B4'))).toBeLessThanOrEqual(3);
  });
});
