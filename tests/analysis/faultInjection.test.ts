/**
 * P0-D：fault-injection benchmark + RCR 测试。
 *
 * 分两层：
 * - 纯函数层（computeRcr / renderRcr）：手造 run 结果，覆盖聚合与「harness 故障不计入 recovered」。
 * - 端到端层（runFaultScenario）：跑真实 Mission 生命周期（store + 状态机 + resume + verify），
 *   只注入 verifier 执行器与会话存储，因此快、确定、不碰真实 ~/.step-pilot。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_SCENARIOS,
  computeRcr,
  renderRcr,
  runFaultScenario,
  type FaultRunResult,
  type FaultScenario,
} from '../../benchmark/faultInjection.js';
import { MissionStore } from '../../src/agent/mission/store.js';
import { SessionStore } from '../../src/session/store.js';

let root: string;
let store: MissionStore;
let sessionStore: SessionStore;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fault-inj-test-'));
  store = new MissionStore(join(root, 'missions'));
  sessionStore = new SessionStore(join(root, 'sessions'));
  repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 造一条最小 run 结果，只覆盖聚合关心的字段。 */
function run(scenario: FaultScenario, recovered: boolean, verification: FaultRunResult['verification']): FaultRunResult {
  return {
    scenario,
    missionId: 'm',
    hadCheckpoint: true,
    resumable: true,
    resumeOk: true,
    verification,
    finalStatus: recovered ? 'completed' : 'running',
    danglingClosed: 0,
    events: 0,
    recovered,
  };
}

describe('computeRcr：纯聚合', () => {
  it('空输入不炸，rcr 为 0', () => {
    const r = computeRcr([]);
    expect(r.total).toBe(0);
    expect(r.rcr).toBe(0);
    expect(r.cleanOracleRecovered).toBe(false);
  });

  it('RCR = recovered / total，并按场景分层', () => {
    const r = computeRcr([run('clean', true, 'passed'), run('kill-after-checkpoint', true, 'passed'), run('kill-after-checkpoint', false, 'failed')]);
    expect(r.total).toBe(3);
    expect(r.recovered).toBe(2);
    expect(r.rcr).toBeCloseTo(2 / 3);
    expect(r.byScenario['kill-after-checkpoint']).toEqual({ runs: 2, recovered: 1, rcr: 0.5 });
    expect(r.byScenario['clean']).toEqual({ runs: 1, recovered: 1, rcr: 1 });
    expect(r.byScenario['kill-during-tool']).toEqual({ runs: 0, recovered: 0, rcr: 0 });
  });

  it('harness 故障不计入 recovered，且单独计数（不与恢复失败混同）', () => {
    const r = computeRcr([run('clean', true, 'passed'), run('verifier-harness-error', false, 'harness-error')]);
    expect(r.recovered).toBe(1);
    expect(r.harnessErrorRuns).toBe(1);
    // 环境故障的 run 既不是成功也不是「确实没恢复」，只出现在独立计数里
    expect(r.byScenario['verifier-harness-error'].recovered).toBe(0);
  });

  it('clean oracle 未通过时如实标记（整批数字不可信）', () => {
    const r = computeRcr([run('clean', false, 'failed'), run('kill-after-checkpoint', true, 'passed')]);
    expect(r.cleanOracleRecovered).toBe(false);
  });
});

describe('renderRcr：报告渲染', () => {
  it('含 RCR 数字、分层表与 harness 故障独立计数', () => {
    const md = renderRcr(computeRcr([run('clean', true, 'passed'), run('verifier-harness-error', false, 'harness-error')]));
    expect(md).toContain('RCR = 50%');
    expect(md).toContain('| clean | 1 | 1 | 100% |');
    expect(md).toContain('环境故障（不可判定，不计入 recovered）：1');
    expect(md).toContain('clean oracle 通过：是');
  });
});

describe('runFaultScenario：真实 Mission 生命周期', () => {
  it('clean 是无中断 oracle：不走恢复也能通过独立 verifier', async () => {
    const r = await runFaultScenario('clean', { repo, store, sessionStore });
    expect(r.finalStatus).toBe('completed');
    expect(r.verification).toBe('passed');
    expect(r.recovered).toBe(true);
  });

  it('kill-before-checkpoint：没有基线也如实恢复并完成（hadCheckpoint=false）', async () => {
    const r = await runFaultScenario('kill-before-checkpoint', { repo, store, sessionStore });
    expect(r.hadCheckpoint).toBe(false);
    expect(r.resumable).toBe(true);
    expect(r.finalStatus).toBe('completed');
    expect(r.recovered).toBe(true);
  });

  it('kill-after-checkpoint：从检查点恢复并完成（hadCheckpoint=true）', async () => {
    const r = await runFaultScenario('kill-after-checkpoint', { repo, store, sessionStore });
    expect(r.hadCheckpoint).toBe(true);
    expect(r.resumable).toBe(true);
    expect(r.finalStatus).toBe('completed');
    expect(r.recovered).toBe(true);
  });

  it('kill-during-tool：悬空 tool_use 被检出并闭合', async () => {
    const r = await runFaultScenario('kill-during-tool', { repo, store, sessionStore });
    // 这条断言是场景有效性的证明：闭合数为 0 说明悬空注入没生效，场景等于空跑
    expect(r.danglingClosed).toBe(1);
    expect(r.recovered).toBe(true);
  });

  it('verifier-harness-error：环境故障退回 running，绝不置 failed/completed', async () => {
    const r = await runFaultScenario('verifier-harness-error', { repo, store, sessionStore });
    expect(r.verification).toBe('harness-error');
    // 核心不变量：环境坏了 ≠ 任务失败。既不是 completed，也不是 failed。
    expect(r.finalStatus).toBe('running');
    expect(r.recovered).toBe(false);
  });
});

describe('runFaultBenchmark：整套场景（通过 runFaultScenario 逐个跑）', () => {
  it('五个场景都能跑完，且 harness 故障被单独计数', async () => {
    const results: FaultRunResult[] = [];
    for (const scenario of ALL_SCENARIOS) {
      const sub = mkdtempSync(join(tmpdir(), 'fault-inj-all-'));
      try {
        results.push(
          await runFaultScenario(scenario, {
            repo: sub,
            store: new MissionStore(join(sub, 'missions')),
            sessionStore: new SessionStore(join(sub, 'sessions')),
          }),
        );
      } finally {
        rmSync(sub, { recursive: true, force: true });
      }
    }
    expect(results).toHaveLength(ALL_SCENARIOS.length);
    const report = computeRcr(results);
    expect(report.cleanOracleRecovered).toBe(true);
    expect(report.harnessErrorRuns).toBe(1);
    // 除环境故障外，其余中断场景都应恢复并完成
    expect(report.recovered).toBe(ALL_SCENARIOS.length - 1);
  });
});
