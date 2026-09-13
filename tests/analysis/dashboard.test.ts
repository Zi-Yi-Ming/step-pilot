import { describe, it, expect } from 'vitest';
import {
  aggregateRuns,
  badgeUrl,
  buildDashboard,
  hasToolLeak,
  isEmptyResponse,
  renderDashboardMd,
} from '../../benchmark/dashboard.js';
import type { BenchmarkReport, RunResult } from '../../benchmark/types.js';

/**
 * 可靠性仪表盘聚合逻辑。
 *
 * 测的重心是**判据正确性**（空响应 / 工具泄漏两条判据的拦截面与不误伤面），
 * 而不是渲染文案——渲染改样式不该让测试红。
 */

function run(over: Partial<RunResult> = {}): RunResult {
  return {
    task_id: 't1',
    category: 'cat',
    profile: 'full',
    model: 'step-3.7-flash',
    provider: 'stepfun',
    step_pilot_commit: 'abc',
    run_index: 1,
    success: true,
    duration_ms: 1000,
    turns: 3,
    tool_calls: 5,
    tool_errors: 0,
    retries: 0,
    compactions: 0,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    stop_reason: 'end_turn',
    failure_reason: null,
    checks_passed: 1,
    checks_failed: 0,
    harness_error: null,
    verification_skipped: false,
    events: [],
    ...over,
  };
}

function report(results: RunResult[]): BenchmarkReport {
  return {
    benchmark_version: '0.1.0',
    timestamp: '2026-09-13T00:00:00Z',
    model: 'step-3.7-flash',
    provider: 'stepfun',
    step_pilot_commit: 'abc',
    profiles: ['full'],
    results,
    summaries: {},
  };
}

describe('isEmptyResponse：空响应判据', () => {
  it('thinking_exhausted 判为空响应（最典型形态）', () => {
    expect(isEmptyResponse(run({ success: false, stop_reason: 'thinking_exhausted' }))).toBe(true);
  });

  it('max_tokens 且零输出判为空响应', () => {
    expect(isEmptyResponse(run({ success: false, stop_reason: 'max_tokens', output_tokens: 0 }))).toBe(true);
  });

  it('max_tokens 但有正常输出 → 不算空响应（是截断，不是空）', () => {
    expect(isEmptyResponse(run({ success: false, stop_reason: 'max_tokens', output_tokens: 800 }))).toBe(false);
  });

  it('failure_reason 文案含空响应特征也能识别', () => {
    expect(isEmptyResponse(run({ success: false, failure_reason: '服务端返回空响应' }))).toBe(true);
    expect(isEmptyResponse(run({ success: false, failure_reason: 'empty response from provider' }))).toBe(true);
  });

  it('普通失败（测试不过）不算空响应', () => {
    expect(isEmptyResponse(run({ success: false, failure_reason: 'test failed', checks_failed: 1 }))).toBe(false);
  });

  it('成功运行不算空响应', () => {
    expect(isEmptyResponse(run({ success: true }))).toBe(false);
  });

  it('合法短答不算空响应（不用输出长度阈值判）', () => {
    // 问 1+1 答 2 的输出 token 天然极少，但 stop_reason 是 end_turn
    expect(isEmptyResponse(run({ success: true, stop_reason: 'end_turn', output_tokens: 2 }))).toBe(false);
  });
});

describe('hasToolLeak：工具泄漏判据', () => {
  it('正文含 <invoke name= 标签判为泄漏', () => {
    const r = run({ events: [{ type: 'text', text: '我来调用 <invoke name="bash">' }] });
    expect(hasToolLeak(r)).toBe(true);
  });

  it('正文含 <function_calls> 判为泄漏', () => {
    const r = run({ events: [{ type: 'text', text: 'prefix <function_calls>' }] });
    expect(hasToolLeak(r)).toBe(true);
  });

  it('antml 前缀形态也识别', () => {
    const r = run({ events: [{ type: 'text', text: '<antml:invoke name="x">' }] });
    expect(hasToolLeak(r)).toBe(true);
  });

  it('裸词不误报（本仓文档里就写着这些词，agent 复述文档极常见）', () => {
    // 这是 AGENTS.md 明确钉住的判据边界：只匹配尖括号标签形态
    const r = run({ events: [{ type: 'text', text: '我们讨论了 function_calls 和 invoke name 这个机制' }] });
    expect(hasToolLeak(r)).toBe(false);
  });

  it('无事件 / 无文本事件 → 不误报', () => {
    expect(hasToolLeak(run({ events: [] }))).toBe(false);
    expect(hasToolLeak(run({ events: [{ type: 'tool_start', name: 'bash' }] }))).toBe(false);
  });
});

describe('aggregateRuns：指标聚合', () => {
  it('成功率 = 成功数 / 总数', () => {
    const m = aggregateRuns([run({ success: true }), run({ success: true }), run({ success: false })]);
    expect(m.runs).toBe(3);
    expect(m.successes).toBe(2);
    expect(m.success_rate).toBeCloseTo(2 / 3);
  });

  it('空响应率与泄漏率各自独立统计', () => {
    const m = aggregateRuns([
      run({ success: false, stop_reason: 'thinking_exhausted' }),
      run({ events: [{ type: 'text', text: '<invoke name="x">' }] }),
      run(),
      run(),
    ]);
    expect(m.empty_response_rate).toBeCloseTo(0.25);
    expect(m.tool_leak_rate).toBeCloseTo(0.25);
  });

  it('缺失字段按 0 处理，不产生 NaN（旧结果文件容错）', () => {
    const legacy = { ...run() } as Record<string, unknown>;
    delete legacy.total_tokens;
    delete legacy.turns;
    const m = aggregateRuns([legacy as unknown as RunResult, run()]);
    expect(Number.isNaN(m.mean_total_tokens)).toBe(false);
    expect(Number.isNaN(m.mean_turns)).toBe(false);
    expect(m.mean_total_tokens).toBe(Math.round(150 / 2));
  });

  it('空输入不炸（除零安全）', () => {
    const m = aggregateRuns([]);
    expect(m.runs).toBe(0);
    expect(m.success_rate).toBe(0);
    expect(m.mean_total_tokens).toBe(0);
  });

  it('失败归因把空响应单列（不与 other 混同）', () => {
    const m = aggregateRuns([run({ success: false, stop_reason: 'thinking_exhausted' })]);
    expect(m.failure_taxonomy.empty_response).toBe(1);
    expect(m.failure_taxonomy.other).toBeUndefined();
  });

  it('中位数偶数个取中间两数均值', () => {
    const m = aggregateRuns([
      run({ total_tokens: 100 }),
      run({ total_tokens: 200 }),
      run({ total_tokens: 300 }),
      run({ total_tokens: 400 }),
    ]);
    expect(m.median_total_tokens).toBe(250);
  });
});

describe('buildDashboard：分组', () => {
  it('按 profile 与 task 双维度分组', () => {
    const d = buildDashboard([
      report([
        run({ profile: 'full', task_id: 'a' }),
        run({ profile: 'full', task_id: 'b' }),
        run({ profile: 'ablation', task_id: 'a', success: false }),
      ]),
    ]);
    expect(d.total_runs).toBe(3);
    expect(d.source_files).toBe(1);
    expect(d.by_profile.map((g) => g.profile)).toEqual(['ablation', 'full']);
    expect(d.by_task.map((t) => t.task_id)).toEqual(['a', 'b']);
    const full = d.by_profile.find((g) => g.profile === 'full')!;
    expect(full.tasks).toEqual(['a', 'b']);
    expect(full.success_rate).toBe(1);
  });

  it('跨多个报告文件累加', () => {
    const d = buildDashboard([report([run()]), report([run({ success: false })])]);
    expect(d.source_files).toBe(2);
    expect(d.total_runs).toBe(2);
    expect(d.overall.success_rate).toBe(0.5);
  });

  it('容忍 results 缺失的报告对象', () => {
    const broken = { ...report([]), results: undefined } as unknown as BenchmarkReport;
    const d = buildDashboard([broken, report([run()])]);
    expect(d.total_runs).toBe(1);
  });
});

describe('渲染', () => {
  it('Markdown 含四条头条指标', () => {
    const md = renderDashboardMd(buildDashboard([report([run()])]));
    expect(md).toContain('成功率');
    expect(md).toContain('空响应率');
    expect(md).toContain('工具泄漏率');
    expect(md).toContain('平均 token');
    // 不得出现未定义因果的措辞
    expect(md).not.toContain('提升了');
  });

  it('徽章按成功率三档配色', () => {
    expect(badgeUrl(buildDashboard([report([run()])]))).toContain('brightgreen');
    const half = buildDashboard([report([run(), run({ success: false })])]);
    expect(badgeUrl(half)).toContain('yellow');
    const low = buildDashboard([report([run({ success: false })])]);
    expect(badgeUrl(low)).toContain('red');
  });
});

/**
 * 框架故障口径（benchmark/HARNESS-AUDIT.md）。
 *
 * 这组测试守的是一个具体的、真实发生过的失效模式：
 * runner 曾用 `rmSync(file, { mode: 0o444 })` 误删测试文件（本意是改只读权限），
 * 导致 verify 恒失败，而仪表盘把「改对了也是失败」读成「模型成功率 50%」。
 * 判据层必须让这类失败**在读数上可见**，否则错误归因还会再发生一次。
 */
describe('框架故障口径', () => {
  it('harness_error 为 null 的运行不计入框架故障', () => {
    const m = aggregateRuns([run(), run({ success: false })]);
    expect(m.harness_broken).toBe(0);
    expect(m.harness_broken_rate).toBe(0);
  });

  it('统计 harness_error 非 null 的运行数与占比', () => {
    const m = aggregateRuns([
      run(),
      run({ success: false, harness_error: 'verify_exec_error' }),
      run({ success: false, verification_skipped: true }),
      run({ success: false }),
    ]);
    expect(m.runs).toBe(4);
    expect(m.harness_broken).toBe(1);
    expect(m.harness_broken_rate).toBe(0.25);
    expect(m.verification_skipped).toBe(1);
    expect(m.verification_skipped_rate).toBe(0.25);
  });

  it('verification_skipped 与 harness_verify_error 分列到不同归因桶', () => {
    const m = aggregateRuns([
      run({ success: false, verification_skipped: true }),
      run({ success: false, harness_error: 'verify_exec_error' }),
    ]);
    expect(m.failure_taxonomy['verification_skipped']).toBe(1);
    expect(m.failure_taxonomy['harness_verify_error']).toBe(1);
  });

  it('框架故障优先于其它归因（不被 test_failure / timeout 抢走）', () => {
    // 误删测试文件后 exit!=0，若按表象归因会被读成 test_failure。
    const m = aggregateRuns([
      run({ success: false, harness_error: 'verify_exec_error', verification_skipped: false, failure_reason: 'test failed' }),
    ]);
    expect(m.failure_taxonomy['harness_verify_error']).toBe(1);
    expect(m.failure_taxonomy['test_failure']).toBeUndefined();
  });

  it('旧格式结果（无 harness_error 字段）按无故障处理，不误报', () => {
    const legacy = run({ success: false }) as unknown as RunResult;
    delete (legacy as { harness_error?: unknown }).harness_error;
    const m = aggregateRuns([legacy]);
    expect(m.harness_broken).toBe(0);
  });

  it('存在框架故障时 Markdown 给出显式警告', () => {
    const md = renderDashboardMd(
      buildDashboard([report([run({ success: false, harness_error: 'verify_exec_error' })])]),
    );
    expect(md).toContain('框架故障');
    expect(md).toContain('与模型能力无关');
  });

  it('无框架故障时不出现警告文案', () => {
    const md = renderDashboardMd(buildDashboard([report([run()])]));
    expect(md).not.toContain('与模型能力无关');
  });
});
