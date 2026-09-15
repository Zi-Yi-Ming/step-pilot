/**
 * Mission 独立 verifier（P0-C）测试。
 *
 * 分三层：
 * - 纯函数层（runCheck / runVerifier）：注入假执行器，确定性覆盖通过 / 断言失败 / 环境故障分支。
 * - 状态机层：verification.completed 在 harness 故障时退回 running，而非 failed/completed（核心不变量）。
 * - CLI 层（verify / prove）：用注入执行器跑整条链路，断言状态迁移、退出码、证据文件。
 *
 * 全程 mock resolveShell 为 family='none'：这样「无可用 shell」的守卫路径可被确定性触发，
 * 而其余用例一律走注入执行器，不依赖真实 shell，保持可重跑。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/tools/shellResolve.js', () => ({
  resolveShell: () => ({ cmd: '', args: (c: string) => [c], family: 'none' as const }),
}));

import { runMissionCommand } from '../../../src/agent/mission/cli.js';
import { MissionStore } from '../../../src/agent/mission/store.js';
import {
  applyMissionEvent,
  emptyMissionState,
  replayMissionEvents,
  type MissionTransitionError,
} from '../../../src/agent/mission/state.js';
import { runCheck, runVerifier, type VerifyExecutor } from '../../../src/agent/mission/verify.js';
import type { MissionAcceptance, MissionEvent, MissionStatus } from '../../../src/agent/mission/types.js';

const TS = '2026-09-15T00:00:00.000Z';
const MID = 'mission-verify-test';

function ev(seq: number, payload: Omit<MissionEvent, 'eventId' | 'seq' | 'ts' | 'missionId' | 'attemptId'>): MissionEvent {
  return { eventId: `evt-${seq}`, seq, ts: TS, missionId: MID, attemptId: 'attempt-1', ...payload } as MissionEvent;
}
function statusChange(seq: number, from: MissionStatus, to: MissionStatus): MissionEvent {
  return ev(seq, { type: 'mission.status_changed', from, to });
}

/** 确定性假执行器：把命令映射到固定结果。 */
function mockExecutor(map: Record<string, { exitCode: number; stdout?: string; stderr?: string }>): VerifyExecutor {
  return (command) => {
    const r = map[command];
    if (r === undefined) return { exitCode: 0, stdout: '', stderr: '' };
    return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

let baseDir: string;
let repo: string;
let store: MissionStore;
const tmpDirs: string[] = [];

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'mission-verify-'));
  repo = await mkdtemp(join(tmpdir(), 'mission-repo-'));
  tmpDirs.push(baseDir, repo);
  store = new MissionStore(baseDir);
});

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

async function makeMission(acceptance: MissionAcceptance[], status: MissionStatus = 'running'): Promise<string> {
  const manifest = store.create({ repo, objective: 'verify test', acceptance });
  if (status !== 'planned') {
    store.appendEvent(repo, manifest.missionId, { type: 'mission.status_changed', from: 'planned', to: status });
  }
  return manifest.missionId;
}

// ---------------- 纯函数层 ----------------

describe('runCheck：退出码对照 + 故障分类', () => {
  it('退出码符合期望 → 通过', () => {
    const r = runCheck({ command: 'true', expectExit: 0 }, mockExecutor({ true: { exitCode: 0 } }));
    expect(r.passed).toBe(true);
    expect(r.harnessError).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it('退出码不符期望（且无环境故障特征）→ 断言失败，不是 harness', () => {
    const r = runCheck(
      { command: 'false', expectExit: 0 },
      mockExecutor({ false: { exitCode: 1, stdout: '', stderr: 'AssertionError: expected 1 to be 2' } }),
    );
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.harnessError).toBeNull();
  });

  it('支持非零期望退出码（「命令必须失败才算对」）', () => {
    const r = runCheck({ command: 'false', expectExit: 1 }, mockExecutor({ false: { exitCode: 1 } }));
    expect(r.passed).toBe(true);
  });

  it('输出命中环境故障特征串 → harnessError 非空（≠ 断言失败）', () => {
    const r = runCheck(
      { command: 'missing-cmd', expectExit: 0 },
      mockExecutor({ 'missing-cmd': { exitCode: 127, stderr: 'bash: missing-cmd: command not found' } }),
    );
    expect(r.passed).toBe(false);
    expect(r.harnessError).not.toBeNull();
    expect(r.harnessError).toMatch(/command not found/);
  });

  it('执行器自身抛错 → 按环境故障处理，不当成断言失败', () => {
    const boom: VerifyExecutor = () => {
      throw new Error('spawn ENOENT');
    };
    const r = runCheck({ command: 'x', expectExit: 0 }, boom);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.harnessError).not.toBeNull();
  });
});

describe('runVerifier：聚合判定', () => {
  it('全部通过 → allPassed=true，harnessError=false', () => {
    const res = runVerifier(
      [
        { command: 'a', expectExit: 0 },
        { command: 'b', expectExit: 0 },
      ],
      { executor: mockExecutor({ a: { exitCode: 0 }, b: { exitCode: 0 } }) },
    );
    expect(res.allPassed).toBe(true);
    expect(res.harnessError).toBe(false);
    expect(res.checks).toHaveLength(2);
  });

  it('任一断言失败 → allPassed=false，harnessError=false', () => {
    const res = runVerifier(
      [
        { command: 'a', expectExit: 0 },
        { command: 'b', expectExit: 0 },
      ],
      { executor: mockExecutor({ a: { exitCode: 0 }, b: { exitCode: 1, stderr: 'AssertionError' } }) },
    );
    expect(res.allPassed).toBe(false);
    expect(res.harnessError).toBe(false);
  });

  it('任一环境故障 → harnessError=true 且 allPassed 必为 false（结论不可采信）', () => {
    const res = runVerifier(
      [
        { command: 'a', expectExit: 0 },
        { command: 'b', expectExit: 0 },
      ],
      { executor: mockExecutor({ a: { exitCode: 0 }, b: { exitCode: 127, stderr: 'No test files found' } }) },
    );
    expect(res.harnessError).toBe(true);
    expect(res.allPassed).toBe(false);
  });
});

// ---------------- 状态机层 ----------------

describe('状态机：verification.completed 的环境故障语义', () => {
  it('harness 故障退回 running，绝不置 completed/failed', () => {
    const s = emptyMissionState();
    applyMissionEvent(s, statusChange(2, 'planned', 'running'));
    applyMissionEvent(s, statusChange(3, 'running', 'verifying'));
    applyMissionEvent(s, ev(4, { type: 'verification.completed', verifierId: 'v', passed: false, harnessError: true }));
    expect(s.status).toBe('running');
    expect(s.lastVerification?.harnessError).toBe(true);
    expect(s.lastVerification?.passed).toBe(false);
  });

  it('passed=true 正常经 completed（harnessError 不影响通过路径）', () => {
    const s = emptyMissionState();
    applyMissionEvent(s, statusChange(2, 'planned', 'running'));
    applyMissionEvent(s, statusChange(3, 'running', 'verifying'));
    applyMissionEvent(s, ev(4, { type: 'verification.completed', verifierId: 'v', passed: true }));
    expect(s.status).toBe('completed');
    expect(s.lastVerification?.passed).toBe(true);
    expect(s.lastVerification?.harnessError).toBeUndefined();
  });

  it('passed=false 无 harness → failed（工程工作没做对，而非环境坏了）', () => {
    const s = emptyMissionState();
    applyMissionEvent(s, statusChange(2, 'planned', 'running'));
    applyMissionEvent(s, statusChange(3, 'running', 'verifying'));
    applyMissionEvent(s, ev(4, { type: 'verification.completed', verifierId: 'v', passed: false }));
    expect(s.status).toBe('failed');
  });

  it('重放容错：伪造的 status_changed→completed 被跳过，真正的 verification.completed 仍生效', () => {
    const events = [
      ev(1, { type: 'mission.created', repo: '/r', objective: 'o', acceptanceCount: 1 }),
      statusChange(2, 'planned', 'running'),
      statusChange(3, 'running', 'completed'), // 伪造：绕过验证，应被跳过（status_changed 拒绝置 completed）
      statusChange(4, 'running', 'verifying'), // 合法的进入 verifying
      ev(5, { type: 'verification.completed', verifierId: 'v', passed: true }),
    ];
    const s = replayMissionEvents(events);
    expect(s.status).toBe('completed');
    expect(s.skippedTransitions).toBe(1);
    expect(s.lastVerification?.passed).toBe(true);
  });
});

// ---------------- CLI 层 ----------------

describe('cmdVerify / cmdProve：整条链路', () => {
  it('全部通过 → completed，退出码 0，事件含 verification.completed(passed=true)', async () => {
    const id = await makeMission([{ command: 'a', expectExit: 0 }]);
    const res = await runMissionCommand(['verify', id], repo, store, {
      verifyExecutor: mockExecutor({ a: { exitCode: 0 } }),
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('验证通过');
    const view = store.load(repo, id)!;
    expect(view.state.status).toBe('completed');
    const v = view.events.find((e) => e.type === 'verification.completed');
    expect(v).toBeDefined();
    if (v && v.type === 'verification.completed') {
      expect(v.passed).toBe(true);
      expect(v.evidenceRef).toBeDefined();
    }
  });

  it('断言失败 → failed，退出码 1', async () => {
    const id = await makeMission([{ command: 'a', expectExit: 0 }]);
    const res = await runMissionCommand(['verify', id], repo, store, {
      verifyExecutor: mockExecutor({ a: { exitCode: 1, stderr: 'AssertionError' } }),
    });
    expect(res.code).toBe(1);
    expect(store.load(repo, id)!.state.status).toBe('failed');
  });

  it('环境故障 → 退回 running（不置 failed），退出码 1，status 标出 harness-error', async () => {
    const id = await makeMission([{ command: 'a', expectExit: 0 }]);
    const res = await runMissionCommand(['verify', id], repo, store, {
      verifyExecutor: mockExecutor({ a: { exitCode: 127, stderr: 'No test files found' } }),
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('WARN');
    const view = store.load(repo, id)!;
    expect(view.state.status).toBe('running');
    expect(view.state.lastVerification?.harnessError).toBe(true);
  });

  it('无接受标准 → 拒绝，退出码 1', async () => {
    const id = await makeMission([]);
    const res = await runMissionCommand(['verify', id], repo, store, { verifyExecutor: mockExecutor({}) });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('接受标准');
    expect(store.load(repo, id)!.state.status).toBe('running'); // 未写入任何验证事件
  });

  it('completed 不可重复验证，stopped/planned 同样被前置检查拦下', async () => {
    const completed = await makeMission([{ command: 'a', expectExit: 0 }]);
    await runMissionCommand(['verify', completed], repo, store, { verifyExecutor: mockExecutor({ a: { exitCode: 0 } }) });
    const again = await runMissionCommand(['verify', completed], repo, store, { verifyExecutor: mockExecutor({ a: { exitCode: 0 } }) });
    expect(again.code).toBe(1);

    const planned = await makeMission([{ command: 'a', expectExit: 0 }], 'planned');
    const p = await runMissionCommand(['verify', planned], repo, store, { verifyExecutor: mockExecutor({}) });
    expect(p.code).toBe(1);
  });

  it('无可用 shell（defaultExecutor 抛错）→ 不写入 verifying，退出码 1', async () => {
    const id = await makeMission([{ command: 'a', expectExit: 0 }]);
    // 不传 verifyExecutor，触发 defaultExecutor；resolveShell 已被 mock 成 family='none'
    const res = await runMissionCommand(['verify', id], repo, store);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('shell');
    expect(store.load(repo, id)!.state.status).toBe('running'); // 没被卡在 verifying
  });

  it('证据文件被写出且可被解析，含完整检查项', async () => {
    const id = await makeMission([{ command: 'a', expectExit: 0 }]);
    await runMissionCommand(['verify', id], repo, store, { verifyExecutor: mockExecutor({ a: { exitCode: 0 } }) });
    const v = store.load(repo, id)!.events.find((e) => e.type === 'verification.completed');
    expect(v && v.type === 'verification.completed' && v.evidenceRef).toBeTruthy();
    if (v && v.type === 'verification.completed' && v.evidenceRef) {
      const { readFileSync } = await import('node:fs');
      const raw = readFileSync(join(store.evidenceDir(repo, id), v.evidenceRef), 'utf8');
      const parsed = JSON.parse(raw) as { allPassed: boolean; checks: { command: string; passed: boolean }[] };
      expect(parsed.allPassed).toBe(true);
      expect(parsed.checks[0].command).toBe('a');
    }
  });

  it('prove 在 verify 基础上导出证据包目录', async () => {
    const id = await makeMission([{ command: 'a', expectExit: 0 }]);
    const outDir = join(baseDir, 'proof-out');
    const res = await runMissionCommand(['prove', id, '--out', outDir], repo, store, {
      verifyExecutor: mockExecutor({ a: { exitCode: 0 } }),
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('证据包已导出');
    const { existsSync, readFileSync } = await import('node:fs');
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(outDir, 'timeline.json'))).toBe(true);
    expect(existsSync(join(outDir, 'verifier-results.json'))).toBe(true);
    expect(existsSync(join(outDir, 'evidence.json'))).toBe(true);
    expect(existsSync(join(outDir, 'README.md'))).toBe(true);
    const tl = JSON.parse(readFileSync(join(outDir, 'timeline.json'), 'utf8')) as MissionEvent[];
    expect(tl.some((e) => e.type === 'verification.completed')).toBe(true);
  });
});
