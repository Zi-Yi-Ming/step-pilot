/**
 * run 抛错时的兜底结果分类。
 *
 * 守住的是一条核心纪律：**harness 故障与模型失败必须分开**。
 *
 * 实测踩过：Windows 上 `rmdir` EBUSY 让最简单的任务 10 个 run 全走进 catch 分支，
 * 兜底结果没标 `harness_error`，于是被当成模型失败计进成功率分母——报告显示
 * 0/10，而真正原因是环境锁目录。分母被悄悄污染，比没有数据更坏。
 */
import { describe, expect, it } from 'vitest';
import { buildErrorResult } from '../../benchmark/runner.js';
import { computeArm } from '../../benchmark/ablationReport.js';
import type { Task } from '../../benchmark/types.js';

const task: Task = {
  id: 'single-file-bug-001',
  category: 'single-file-bug-fix',
  difficulty: 'easy',
  description: 'fix the off-by-one',
  repository: 'benchmark/tasks/single-file-bug/001-off-by-one/repo',
  setup: 'x.sh',
  verify: [],
  timeout: 120,
} as unknown as Task;

describe('buildErrorResult：抛错的 run 必须归类为 harness 故障', () => {
  it('标上 harness_error，消息就是原始错误', () => {
    const r = buildErrorResult(task, 'full', 3, new Error('EBUSY: resource busy or locked'));
    expect(r.harness_error).toBe('EBUSY: resource busy or locked');
    expect(r.failure_reason).toBe('EBUSY: resource busy or locked');
  });

  it('verification_skipped 为 true——验证从未发生，不能冒充「未通过」', () => {
    const r = buildErrorResult(task, 'full', 1, new Error('boom'));
    expect(r.verification_skipped).toBe(true);
  });

  it('非 Error 抛出也能取到消息（String(err)）', () => {
    const r = buildErrorResult(task, 'full', 1, 'plain string failure');
    expect(r.harness_error).toBe('plain string failure');
  });

  it('turn/profile/run_index 等标识字段如实带上，便于回溯到具体哪一次', () => {
    const r = buildErrorResult(task, 'ablation', 7, new Error('x'));
    expect(r.profile).toBe('ablation');
    expect(r.run_index).toBe(7);
    expect(r.task_id).toBe('single-file-bug-001');
    expect(r.success).toBe(false);
  });
});

describe('端到端：兜底结果不得污染成功率分母', () => {
  it('10 个 EBUSY run + 2 个真实 run → 成功率按 2 个算，不按 12 个', () => {
    const errs = Array.from({ length: 10 }, (_, i) => buildErrorResult(task, 'full', i + 1, new Error('EBUSY')));
    const real = [
      { success: true, turns: 6, tool_calls: 8, duration_ms: 33_000, total_tokens: 12_000, harness_error: null },
      { success: true, turns: 4, tool_calls: 5, duration_ms: 30_000, total_tokens: 11_000, harness_error: null },
    ] as unknown as Parameters<typeof computeArm>[0];

    const arm = computeArm([...errs, ...real]);
    expect(arm.runs).toBe(12);
    expect(arm.scoredRuns).toBe(2); // 环境故障被剔除
    expect(arm.harnessErrorRuns).toBe(10);
    expect(arm.successRate).toBe(1); // 不是 2/12
  });

  it('修复前：没有 harness_error 字段时，同样的数据会算出 17% 的假成功率', () => {
    // 这是回归前的行为，钉住它有多坏：10 个环境故障把 2 个成功稀释成 17%
    const bad = Array.from({ length: 10 }, (_, i) => ({
      ...buildErrorResult(task, 'full', i + 1, new Error('EBUSY')),
      harness_error: null, // 模拟修复前的兜底结果
    })) as unknown as Parameters<typeof computeArm>[0];
    const arm = computeArm(bad);
    expect(arm.successRate).toBe(0);
    expect(arm.harnessErrorRuns).toBe(0); // 完全看不见
  });
});
