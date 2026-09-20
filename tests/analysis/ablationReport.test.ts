/**
 * ablation 分析层测试。
 *
 * 钉住三条纪律，它们都是「数字看起来很准但其实不能那么用」的防线：
 * 1. harness 故障 run 不进成功率分母，但必须单独计数；
 * 2. CI 半宽超阈值时，报告必须显式标注「只能作方向性参考」；
 * 3. Δ 的方向定义必须是 full − ablation（正数 = harness 有正贡献）。
 */
import { describe, expect, it } from 'vitest';
import {
  CI_HALF_WIDTH_MAX,
  computeAblation,
  computeArm,
  renderAblation,
} from '../../benchmark/ablationReport.js';
import type { RunResult } from '../../benchmark/types.js';

function run(patch: Partial<RunResult>): RunResult {
  return {
    task_id: 't',
    category: 'c',
    profile: 'full',
    model: 'step-3.7-flash',
    provider: 'stepfun',
    step_pilot_commit: 'abc1234',
    run_index: 1,
    success: true,
    duration_ms: 40_000,
    turns: 6,
    tool_calls: 7,
    tool_errors: 0,
    retries: 0,
    compactions: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 12_000,
    stop_reason: null,
    failure_reason: null,
    checks_passed: 1,
    checks_failed: 0,
    harness_error: null,
    verification_skipped: false,
    events: [],
    ...patch,
  } as RunResult;
}

describe('computeArm：分母纪律', () => {
  it('harness 故障 run 不计入分母，但单独计数', () => {
    const arm = computeArm([
      run({ success: true }),
      run({ success: false, failure_reason: 'model gave up' }),
      run({ success: true, harness_error: 'No test files found' }),
    ]);
    expect(arm.runs).toBe(3);
    expect(arm.scoredRuns).toBe(2); // 剔除环境故障
    expect(arm.harnessErrorRuns).toBe(1);
    expect(arm.successes).toBe(1);
    expect(arm.successRate).toBe(0.5);
  });

  it('全部 run 都是环境故障时，成功率是 0 而不是 NaN', () => {
    const arm = computeArm([run({ success: false, harness_error: 'cmd not found' })]);
    expect(arm.successRate).toBe(0);
    expect(arm.scoredRuns).toBe(0);
    expect(Number.isNaN(arm.successRate)).toBe(false);
  });

  it('空输入不炸', () => {
    const arm = computeArm([]);
    expect(arm.runs).toBe(0);
    expect(arm.avgTurns).toBe(0);
  });

  it('均值只统计计入分母的 run', () => {
    const arm = computeArm([run({ turns: 10 }), run({ turns: 20, harness_error: 'broken' })]);
    expect(arm.avgTurns).toBe(10); // 不是 15
  });
});

describe('computeArm：Wilson CI', () => {
  it('样本越小区间越宽——小样本不会装出精确的样子', () => {
    const small = computeArm(Array.from({ length: 3 }, () => run({})));
    const big = computeArm(Array.from({ length: 30 }, () => run({})));
    expect(small.ciHalfWidth).toBeGreaterThan(big.ciHalfWidth);
  });

  it('CI 不越界 [0,1]', () => {
    const arm = computeArm([run({}), run({}), run({})]);
    expect(arm.ci[0]).toBeGreaterThanOrEqual(0);
    expect(arm.ci[1]).toBeLessThanOrEqual(1);
  });

  it('半宽就是 (hi-lo)/2', () => {
    const arm = computeArm([run({}), run({}), run({}), run({})]);
    expect(arm.ciHalfWidth).toBeCloseTo((arm.ci[1] - arm.ci[0]) / 2);
  });
});

describe('computeAblation：Δ 的方向', () => {
  it('Δ = full − ablation，正数表示 harness 有正贡献', () => {
    const r = computeAblation(
      Array.from({ length: 10 }, () => run({ success: true, turns: 6 })),
      Array.from({ length: 10 }, () => run({ success: false, turns: 12 })),
    );
    expect(r.overall.delta.successRate).toBe(1);
    expect(r.overall.delta.avgTurns).toBe(-6); // full 轮次更少 → 负值表示 harness 更省
    expect(r.overall.full.successRate).toBe(1);
    expect(r.overall.ablation.successRate).toBe(0);
  });

  it('按任务分行，overall 是全部 run 的汇总', () => {
    const r = computeAblation(
      [run({ task_id: 'a', success: true }), run({ task_id: 'b', success: false })],
      [run({ task_id: 'a', success: false }), run({ task_id: 'b', success: true })],
    );
    expect(r.rows.map((x) => x.task_id)).toEqual(['a', 'b']);
    expect(r.overall.full.runs).toBe(2);
    expect(r.overall.ablation.runs).toBe(2);
  });

  it('任一臂 CI 半宽超限 → anyInsufficient', () => {
    const r = computeAblation([run({}), run({})], [run({}), run({})]);
    expect(r.anyInsufficient).toBe(true); // n=2 必然很宽
  });

  it('n 足够且差异明显时可以不做警示', () => {
    const full = Array.from({ length: 40 }, () => run({ success: true }));
    const abl = Array.from({ length: 40 }, () => run({ success: true }));
    const r = computeAblation(full, abl);
    expect(r.anyInsufficient).toBe(false);
    expect(CI_HALF_WIDTH_MAX).toBeGreaterThan(0);
  });
});

describe('renderAblation：报告必须自己说清能不能用', () => {
  it('CI 过宽时显式禁止定量表述', () => {
    const md = renderAblation(computeAblation([run({}), run({})], [run({}), run({})]));
    expect(md).toContain('只能作方向性参考');
    expect(md).toContain('不得作为定量结论引用');
  });

  it('写清分母规则（剔除 harness 故障）', () => {
    const md = renderAblation(computeAblation([run({})], [run({})]));
    expect(md).toContain('分母已剔除 harness 故障');
  });

  it('环境故障例数被显式报告', () => {
    const md = renderAblation(computeAblation([run({}), run({ harness_error: 'broken' })], [run({})]));
    expect(md).toContain('环境故障 run 共 1 例');
  });

  it('Δ 的方向说明写进报告', () => {
    const md = renderAblation(computeAblation([run({})], [run({})]));
    expect(md).toContain('full − ablation');
  });

  it('表格里有分数与样本量，不只给百分比', () => {
    const md = renderAblation(computeAblation([run({}), run({})], [run({})]));
    expect(md).toMatch(/\(2\/2\)/);
    expect(md).toMatch(/\(1\/1\)/);
  });
});
