import { describe, it, expect } from 'vitest';
import { summarize } from '../benchmark/reporter.js';
import type { RunResult } from '../benchmark/types.js';

function makeRun(partial: Partial<RunResult>): RunResult {
  return {
    task_id: 'cascading-fix-001',
    category: 'recovery',
    profile: 'full',
    model: 'step-3.7-flash',
    provider: 'stepfun',
    step_pilot_commit: 'abc123',
    run_index: 1,
    success: true,
    duration_ms: 1000,
    turns: 5,
    tool_calls: 5,
    tool_errors: 0,
    retries: 0,
    compactions: 0,
    input_tokens: 100,
    output_tokens: 100,
    total_tokens: 200,
    stop_reason: null,
    failure_reason: null,
    checks_passed: 1,
    checks_failed: 0,
    events: [],
    ...partial,
  };
}

describe('reporter summarize', () => {
  it('does not treat agent bash errors as verifier failures', () => {
    // Agent had bash errors, but verifier passed (checks_failed=0).
    const run = makeRun({
      run_index: 1,
      success: true,
      tool_errors: 3,
      checks_passed: 1,
      checks_failed: 0,
      events: [
        { type: 'thinking_start' },
        { type: 'tool_end', name: 'bash', isError: true },
        { type: 'thinking_start' },
        { type: 'tool_end', name: 'bash', isError: false },
      ],
    });

    const summary = summarize([run])['cascading-fix-001'];

    expect(summary.success_rate).toBeCloseTo(1.0);
    expect(summary.final_verifier_failure_rate).toBeCloseTo(0);
    expect(summary.timeout_rate).toBeCloseTo(0);
  });

  it('counts final verifier failure from checks_failed, not agent events', () => {
    const run = makeRun({
      run_index: 1,
      success: false,
      checks_passed: 0,
      checks_failed: 1,
      events: [],
    });

    const summary = summarize([run])['cascading-fix-001'];

    expect(summary.success_rate).toBeCloseTo(0);
    expect(summary.final_verifier_failure_rate).toBeCloseTo(1.0);
  });

  it('computes timeout_rate when duration exceeds threshold', () => {
    const run = makeRun({
      run_index: 1,
      success: false,
      duration_ms: 200_000,
      failure_reason: 'timeout',
      checks_passed: 0,
      checks_failed: 1,
    });

    const summary = summarize([run])['cascading-fix-001'];

    expect(summary.timeout_rate).toBeCloseTo(1.0);
  });

  it('computes summary metrics from multiple runs', () => {
    const runs = [
      makeRun({ run_index: 1, success: true, turns: 6, tool_calls: 5, tool_errors: 1, total_tokens: 100, duration_ms: 1000 }),
      makeRun({ run_index: 2, success: false, turns: 8, tool_calls: 7, tool_errors: 2, total_tokens: 200, duration_ms: 2000, checks_failed: 1 }),
    ];

    const summary = summarize(runs)['cascading-fix-001'];

    expect(summary.runs).toBe(2);
    expect(summary.success_rate).toBeCloseTo(0.5);
    expect(summary.final_verifier_failure_rate).toBeCloseTo(0.5);
    expect(summary.mean_turns).toBeCloseTo(7);
    expect(summary.mean_tool_calls).toBeCloseTo(6);
    expect(summary.mean_tool_errors).toBeCloseTo(1.5);
    expect(summary.mean_total_tokens).toBeCloseTo(150);
    expect(summary.mean_duration_ms).toBeCloseTo(1500);
  });

  it('does not expose recovery metrics in summary', () => {
    const run = makeRun({});

    const summary = summarize([run])['cascading-fix-001'];

    expect(summary).not.toHaveProperty('first_pass_success_rate');
    expect(summary).not.toHaveProperty('failure_rate');
    expect(summary).not.toHaveProperty('recovery_given_failure');
    expect(summary).not.toHaveProperty('avg_turns_to_pass_given_failure');
  });
});
