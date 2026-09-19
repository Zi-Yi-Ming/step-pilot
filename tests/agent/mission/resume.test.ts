/**
 * Mission 恢复分析测试。
 *
 * 分两层：
 * - 纯函数层（buildRecoveryPlan / lastCheckpointOf）：注入假探测，覆盖全部分支，快且确定。
 * - CLI 层（checkpoint / resume）：必须真跑 git 才算数（漂移判定是 git 语义），用临时真仓。
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

// 真跑 git 的用例在 Windows 上进程创建慢，抬高超时（与 team.test.ts 同款理由）
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import { runMissionCommand, buildContinuationPrompt } from '../../../src/agent/mission/cli.js';
import { MissionStore } from '../../../src/agent/mission/store.js';
import { replayMissionEvents } from '../../../src/agent/mission/state.js';
import { buildRecoveryPlan, createSessionProbe, lastCheckpointOf } from '../../../src/agent/mission/resume.js';
import { stored } from '../../../src/agent/message.js';
import { SessionStore } from '../../../src/session/store.js';
import { textBlock, toolUseBlock } from '../../helpers/fakeProvider.js';
import type { GitInspection } from '../../../src/agent/mission/git.js';
import type { MissionEvent, MissionManifest, MissionStatus, MissionView } from '../../../src/agent/mission/types.js';

/** tool_result 块构造（副作用账本用例用，fakeProvider 未提供）。 */
function toolResultBlock(id: string, content: string, isError = false): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) };
}

const run = promisify(execFile);
const tmpDirs: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args]);
  return stdout.trim();
}

/** 建一个有一次提交的真 git 仓（漂移判定必须真跑 git）。 */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mission-repo-'));
  tmpDirs.push(dir);
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'test']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(dir, 'README.md'), 'hello\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

let baseDir: string;
let store: MissionStore;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'mission-test-'));
  tmpDirs.push(baseDir);
  store = new MissionStore(baseDir);
});

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

// ---------------- 纯函数层 ----------------

function ev(seq: number, payload: Omit<MissionEvent, 'eventId' | 'seq' | 'ts' | 'missionId' | 'attemptId'>): MissionEvent {
  return { eventId: `evt-${seq}`, seq, ts: '2026-09-15T00:00:00.000Z', missionId: 'm1', attemptId: 'attempt-1', ...payload } as MissionEvent;
}

/**
 * 造一个视图。默认状态是 running（可恢复）——否则 plan 会在可恢复性检查处提前返回，
 * 后面的漂移/确认分支根本走不到。要测不可恢复的状态就显式传。
 */
function viewOf(events: MissionEvent[], status: MissionStatus = 'running'): MissionView {
  const manifest: MissionManifest = {
    manifestVersion: 1,
    missionId: 'm1',
    repo: '/repo',
    objective: '修复重复扣款',
    acceptance: [{ command: 'pnpm vitest run', expectExit: 0 }],
    policy: {},
    createdAt: '2026-09-15T00:00:00.000Z',
  };
  const state = replayMissionEvents(events);
  state.status = status;
  return { manifest, state, events };
}

const CLEAN: GitInspection = { available: true, head: 'aaa1111', dirty: false, uncommittedChanges: [] };

describe('lastCheckpointOf', () => {
  it('取最近一个检查点（含 git 元数据）', () => {
    const events = [
      ev(1, { type: 'checkpoint.created', checkpointId: 'cp-1', label: '第一个' }),
      ev(2, { type: 'checkpoint.created', checkpointId: 'cp-2', label: '第二个', gitHead: 'bbb2222', dirty: true }),
    ];
    expect(lastCheckpointOf(events)).toEqual({ checkpointId: 'cp-2', label: '第二个', ts: '2026-09-15T00:00:00.000Z', gitHead: 'bbb2222', dirty: true });
  });

  it('没有检查点时返回 undefined', () => {
    expect(lastCheckpointOf([ev(1, { type: 'recovery.completed', replayedEvents: 0 })])).toBeUndefined();
  });
});

describe('buildRecoveryPlan：可恢复性直接来自状态机迁移表', () => {
  it('planned 不可恢复，且说明原因', () => {
    const plan = buildRecoveryPlan({ view: viewOf([], 'planned'), health: { corruptLines: 0 } });
    expect(plan.resumable).toBe(false);
    expect(plan.blockReason).toContain('尚未开始');
  });

  it('completed / stopped 是终态，不可恢复', () => {
    for (const terminal of ['completed', 'stopped'] as MissionStatus[]) {
      const plan = buildRecoveryPlan({ view: viewOf([], terminal), health: { corruptLines: 0 } });
      expect(plan.resumable).toBe(false);
      expect(plan.blockReason).toContain('终态');
    }
  });

  it('failed / blocked / paused / verifying / running 都可恢复', () => {
    for (const s of ['failed', 'blocked', 'paused', 'verifying', 'running'] as MissionStatus[]) {
      expect(buildRecoveryPlan({ view: viewOf([], s), health: { corruptLines: 0 } }).resumable).toBe(true);
    }
  });
});

describe('buildRecoveryPlan：漂移判定', () => {
  const ckpt = ev(1, { type: 'checkpoint.created', checkpointId: 'cp-1', label: 'x', gitHead: 'aaa1111' });

  it('HEAD 一致且干净 → 无漂移', () => {
    const plan = buildRecoveryPlan({ view: viewOf([ckpt]), health: { corruptLines: 0 }, git: CLEAN });
    expect(plan.drift?.kind).toBe('none');
    expect(plan.drift?.files).toEqual([]);
  });

  it('HEAD 变了 → committed 漂移并列出文件', () => {
    const git: GitInspection = { available: true, head: 'ccc3333', dirty: false, committedChanges: ['src/a.ts', 'src/b.ts'] };
    const plan = buildRecoveryPlan({ view: viewOf([ckpt]), health: { corruptLines: 0 }, git });
    expect(plan.drift?.kind).toBe('committed');
    expect(plan.drift?.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(plan.needsConfirmation.some((n) => n.includes('提交层面的变更'))).toBe(true);
  });

  it('HEAD 一致但不干净 → uncommitted 漂移', () => {
    const git: GitInspection = { available: true, head: 'aaa1111', dirty: true, uncommittedChanges: ['src/wip.ts'] };
    const plan = buildRecoveryPlan({ view: viewOf([ckpt]), health: { corruptLines: 0 }, git });
    expect(plan.drift?.kind).toBe('uncommitted');
    expect(plan.needsConfirmation.some((n) => n.includes('未提交改动'))).toBe(true);
  });

  it('HEAD 变了但列不出文件（rebase/历史改写）→ 仍是 committed，但附 note', () => {
    const git: GitInspection = { available: true, head: 'ccc3333', dirty: false, committedChanges: [] };
    const plan = buildRecoveryPlan({ view: viewOf([ckpt]), health: { corruptLines: 0 }, git });
    expect(plan.drift?.kind).toBe('committed');
    expect(plan.drift?.note).toContain('rebase');
  });

  it('无检查点 → unknown（不是「无漂移」）', () => {
    const plan = buildRecoveryPlan({ view: viewOf([]), health: { corruptLines: 0 }, git: CLEAN });
    expect(plan.drift?.kind).toBe('unknown');
    expect(plan.needsConfirmation.some((n) => n.includes('尚无检查点'))).toBe(true);
  });

  it('检查点未记录 HEAD → unknown，且说明原因', () => {
    const noHead = ev(1, { type: 'checkpoint.created', checkpointId: 'cp-1', label: 'x' });
    const plan = buildRecoveryPlan({ view: viewOf([noHead]), health: { corruptLines: 0 }, git: CLEAN });
    expect(plan.drift?.kind).toBe('unknown');
    expect(plan.drift?.note).toContain('未记录 HEAD');
  });

  it('git 不可用 → unknown，不假装无漂移', () => {
    const plan = buildRecoveryPlan({
      view: viewOf([ckpt]),
      health: { corruptLines: 0 },
      git: { available: false, note: '不在 git 工作区内' },
    });
    expect(plan.drift?.kind).toBe('unknown');
    expect(plan.drift?.note).toContain('不在 git 工作区');
  });

  it('空仓（无 HEAD）→ unknown', () => {
    const plan = buildRecoveryPlan({ view: viewOf([ckpt]), health: { corruptLines: 0 }, git: { available: true, dirty: false } });
    expect(plan.drift?.kind).toBe('unknown');
    expect(plan.drift?.note).toContain('空仓');
  });

  it('脏检查点被标为不可作干净基线', () => {
    const dirtyCkpt = ev(1, { type: 'checkpoint.created', checkpointId: 'cp-1', label: 'x', gitHead: 'aaa1111', dirty: true });
    const plan = buildRecoveryPlan({ view: viewOf([dirtyCkpt]), health: { corruptLines: 0 }, git: CLEAN });
    expect(plan.needsConfirmation.some((n) => n.includes('不干净的工作区'))).toBe(true);
  });
});

describe('buildRecoveryPlan：会话与未决项', () => {
  const ckpt = ev(1, { type: 'checkpoint.created', checkpointId: 'cp-1', label: 'x', gitHead: 'aaa1111' });

  it('悬空工具调用进入需要确认，并出现在恢复计划里', () => {
    const plan = buildRecoveryPlan({
      view: viewOf([ckpt]),
      health: { corruptLines: 0 },
      git: CLEAN,
      session: { sessionId: 's1', exists: true, messageCount: 42, danglingToolUseIds: ['tu_1', 'tu_2'] },
    });
    expect(plan.needsConfirmation.some((n) => n.includes('2 个未闭合的工具调用'))).toBe(true);
    expect(plan.steps.some((s) => s.includes('闭合会话 s1 末尾的悬空工具调用'))).toBe(true);
  });

  it('manifest 记了会话但找不到 → 明确提示信号不可用', () => {
    const view = viewOf([ckpt]);
    view.manifest.sessionId = 's-missing';
    const plan = buildRecoveryPlan({
      view,
      health: { corruptLines: 0 },
      git: CLEAN,
      session: { sessionId: 's-missing', exists: false, messageCount: 0, danglingToolUseIds: [] },
    });
    expect(plan.needsConfirmation.some((n) => n.includes('找不到它'))).toBe(true);
  });

  it('接受标准尚未执行 → 明确说明本次恢复不能宣称完成', () => {
    const plan = buildRecoveryPlan({ view: viewOf([ckpt]), health: { corruptLines: 0 }, git: CLEAN });
    expect(plan.needsConfirmation.some((n) => n.includes('step mission verify'))).toBe(true);
  });

  it('日志损坏 / 非法迁移 / 序号缺口都进告警', () => {
    const events = [
      ev(1, { type: 'checkpoint.created', checkpointId: 'cp-1', label: 'x', gitHead: 'aaa1111' }),
      ev(5, { type: 'recovery.completed', replayedEvents: 0 }),
    ];
    const view = viewOf(events);
    view.state.skippedTransitions = 2;
    const plan = buildRecoveryPlan({ view, health: { corruptLines: 3 }, git: CLEAN });
    expect(plan.warnings.some((w) => w.includes('3 行无法解析'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('2 次非法状态迁移'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('序号存在缺口'))).toBe(true);
  });

  it('纯函数：不修改入参视图', () => {
    const view = viewOf([ckpt]);
    const snapshot = JSON.stringify(view);
    buildRecoveryPlan({ view, health: { corruptLines: 0 }, git: CLEAN });
    expect(JSON.stringify(view)).toBe(snapshot);
  });
});

describe('createSessionProbe', () => {
  it('会话存在且有悬空调用 → 如实报告，并派生副作用账本', () => {
    const probe = createSessionProbe({
      resume: () => ({
        session: {
          messages: [
            stored(
              { role: 'assistant', content: [toolUseBlock('tu_9', 'write_file', { path: 'a.ts' })] },
              { kind: 'assistant' },
            ),
          ],
        },
        closedDanglingToolUse: true,
        closedToolUseIds: ['tu_9'],
      }),
    });
    const inspection = probe.inspect('/repo', 's1');
    expect(inspection.sessionId).toBe('s1');
    expect(inspection.exists).toBe(true);
    expect(inspection.messageCount).toBe(1);
    expect(inspection.danglingToolUseIds).toEqual(['tu_9']);
    // 真实 store 返回 StoredMessage，probe 从中派生账本；悬空调用即未闭环副作用
    expect(inspection.effects).toHaveLength(1);
    expect(inspection.effects![0]!.effectId).toBe('tu_9');
    expect(inspection.effects![0]!.status).toBe('uncertain');
  });

  it('会话不存在 → exists:false，不抛错', () => {
    const probe = createSessionProbe({ resume: () => null });
    expect(probe.inspect('/repo', 's1').exists).toBe(false);
  });

  it('没有悬空调用 → 空数组（closedDanglingToolUse=false 时不采信 ids）', () => {
    const probe = createSessionProbe({
      resume: () => ({ session: { messages: [] }, closedDanglingToolUse: false, closedToolUseIds: ['stale'] }),
    });
    expect(probe.inspect('/repo', 's1').danglingToolUseIds).toEqual([]);
  });
});

// ---------------- CLI 层（真 git 仓） ----------------

/** 建一个 running 状态的 Mission，返回 id。 */
async function makeRunningMission(repo: string, extra: string[] = []): Promise<string> {
  const created = await runMissionCommand(['create', '--objective', '修复重复扣款', ...extra], repo, store);
  const id = /mission-[0-9a-z-]+/.exec(created.stdout ?? '')![0];
  store.appendEvent(repo, id, { type: 'mission.status_changed', from: 'planned', to: 'running' });
  return id;
}

describe('mission checkpoint（真 git 仓）', () => {
  it('干净工作区记录检查点，带上 HEAD', async () => {
    const repo = await makeRepo();
    const id = await makeRunningMission(repo);
    const res = await runMissionCommand(['checkpoint', id, '--label', '改完第一段'], repo, store);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('已记录检查点 cp-001');
    const view = store.load(repo, id)!;
    const ckpt = lastCheckpointOf(view.events)!;
    expect(ckpt.gitHead).toBe(await git(repo, ['rev-parse', 'HEAD']));
    expect(ckpt.dirty).toBeUndefined();
  });

  it('工作区不干净时默认拒绝，并列出未提交文件', async () => {
    const repo = await makeRepo();
    const id = await makeRunningMission(repo);
    await writeFile(join(repo, 'wip.ts'), 'export const x = 1;\n');
    const res = await runMissionCommand(['checkpoint', id, '--label', 'x'], repo, store);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('工作区不干净');
    expect(res.stderr).toContain('wip.ts');
    expect(res.stderr).toContain('--allow-dirty');
  });

  it('--allow-dirty 记录检查点，并标记 dirty', async () => {
    const repo = await makeRepo();
    const id = await makeRunningMission(repo);
    await writeFile(join(repo, 'wip.ts'), 'export const x = 1;\n');
    const res = await runMissionCommand(['checkpoint', id, '--label', 'x', '--allow-dirty'], repo, store);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('脏工作区');
    expect(lastCheckpointOf(store.load(repo, id)!.events)!.dirty).toBe(true);
  });

  it('检查点 id 递增，且记录相对上一个检查点的提交变更', async () => {
    const repo = await makeRepo();
    const id = await makeRunningMission(repo);
    await runMissionCommand(['checkpoint', id, '--label', '第一个'], repo, store);
    await writeFile(join(repo, 'src.ts'), 'export const y = 2;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'add src']);
    const res = await runMissionCommand(['checkpoint', id, '--label', '第二个'], repo, store);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('cp-002');
    expect(res.stdout).toContain('1 个文件');
    expect(lastCheckpointOf(store.load(repo, id)!.events)!.changedFiles).toEqual(['src.ts']);
  });

  it('缺少 --label 被拒绝', async () => {
    const repo = await makeRepo();
    const id = await makeRunningMission(repo);
    const res = await runMissionCommand(['checkpoint', id], repo, store);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--label');
  });

  it('planned 状态不接受检查点（没有可恢复的东西）', async () => {
    const repo = await makeRepo();
    const created = await runMissionCommand(['create', '--objective', 'o'], repo, store);
    const id = /mission-[0-9a-z-]+/.exec(created.stdout ?? '')![0];
    const res = await runMissionCommand(['checkpoint', id, '--label', 'x'], repo, store);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('不接受检查点');
  });

  it('非 git 目录被拒绝', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'mission-plain-'));
    tmpDirs.push(plain);
    const id = await makeRunningMission(plain);
    const res = await runMissionCommand(['checkpoint', id, '--label', 'x'], plain, store);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('无法读取仓库状态');
  });
});

describe('mission resume（真 git 仓）', () => {
  it('无 --confirm 时是只读的：事件数不变', async () => {
    const repo = await makeRepo();
    const id = await makeRunningMission(repo);
    await runMissionCommand(['checkpoint', id, '--label', '第一段'], repo, store);
    const before = store.load(repo, id)!.events.length;
    const res = await runMissionCommand(['resume', id], repo, store);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('只读');
    expect(res.stdout).toContain('无（HEAD 与检查点一致，工作区干净）');
    expect(store.load(repo, id)!.events.length).toBe(before);
  });

  it('--confirm 写入恢复事件并把状态推回 running', async () => {
    const repo = await makeRepo();
    const id = await makeRunningMission(repo);
    await runMissionCommand(['checkpoint', id, '--label', '第一段'], repo, store);
    // 制造一次失败，确认恢复能把状态带回 running
    store.appendEvent(repo, id, { type: 'mission.status_changed', from: 'running', to: 'failed', reason: '工具失败' });
    const res = await runMissionCommand(['resume', id, '--confirm'], repo, store);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('已记录恢复');
    const view = store.load(repo, id)!;
    expect(view.state.status).toBe('running');
    expect(view.state.recoveryCount).toBe(1);
  });

  it('检查点之后有新提交 → 恢复分析报 committed 漂移', async () => {
    const repo = await makeRepo();
    const id = await makeRunningMission(repo);
    await runMissionCommand(['checkpoint', id, '--label', '第一段'], repo, store);
    await writeFile(join(repo, 'later.ts'), 'export const z = 3;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'later work']);
    const res = await runMissionCommand(['resume', id], repo, store);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('检查点之后有提交变更');
    expect(res.stdout).toContain('later.ts');
  });

  it('planned 的 Mission 不可恢复，退出码 1', async () => {
    const repo = await makeRepo();
    const created = await runMissionCommand(['create', '--objective', 'o'], repo, store);
    const id = /mission-[0-9a-z-]+/.exec(created.stdout ?? '')![0];
    const res = await runMissionCommand(['resume', id], repo, store);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('尚未开始');
  });

  it('找不到 Mission 时退出码 1', async () => {
    const repo = await makeRepo();
    const res = await runMissionCommand(['resume', 'mission-nope'], repo, store);
    expect(res.code).toBe(1);
  });

  it('--session 关联的会话找不到时，恢复分析明确提示信号不可用', async () => {
    const repo = await makeRepo();
    const id = await makeRunningMission(repo, ['--session', 's-does-not-exist']);
    const res = await runMissionCommand(['resume', id], repo, store);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('s-does-not-exist');
    expect(res.stdout).toContain('找不到它');
  });
});

describe('mission resume --run（恢复接回执行）', () => {
  it('--run 不带 --confirm 时拒绝：真实启动 agent 不允许在只读分析里隐式发生', async () => {
    const repo = await makeRepo();
    const id = await makeRunningMission(repo);
    await runMissionCommand(['checkpoint', id, '--label', '第一段'], repo, store);
    const before = store.load(repo, id)!.events.length;
    const res = await runMissionCommand(['resume', id, '--run'], repo, store);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--run');
    expect(res.stderr).toContain('--confirm');
    // 拒绝路径不写任何事件
    expect(store.load(repo, id)!.events.length).toBe(before);
  });

  it('--confirm --run 写完恢复事件后返回桥接载荷：prompt 含目标/检查点/verify 指引，sessionId 透传', async () => {
    const repo = await makeRepo();
    const id = await makeRunningMission(repo, ['--session', 'sess-1']);
    await runMissionCommand(['checkpoint', id, '--label', '改完 payment.ts'], repo, store);
    const res = await runMissionCommand(['resume', id, '--confirm', '--run'], repo, store);
    expect(res.code).toBe(0);
    expect(res.continueRun).toBeDefined();
    expect(res.continueRun!.sessionId).toBe('sess-1');
    const p = res.continueRun!.prompt;
    expect(p).toContain('修复重复扣款'); // objective 原样进入 prompt
    expect(p).toContain('改完 payment.ts'); // 检查点 label
    expect(p).toContain('step mission verify'); // 完成判定指向独立 verifier，不自报
    expect(p).toContain('Do NOT declare completion yourself');
    // 恢复事件照常写入（--run 不改变 --confirm 的事实链语义）
    const view = store.load(repo, id)!;
    expect(view.state.status).toBe('running');
    expect(view.state.recoveryCount).toBe(1);
  });

  it('manifest 未关联会话时 continueRun 不带 sessionId（组合根走新建会话）', async () => {
    const repo = await makeRepo();
    const id = await makeRunningMission(repo);
    await runMissionCommand(['checkpoint', id, '--label', 'x'], repo, store);
    const res = await runMissionCommand(['resume', id, '--confirm', '--run'], repo, store);
    expect(res.code).toBe(0);
    expect(res.continueRun).toBeDefined();
    expect(res.continueRun!.sessionId).toBeUndefined();
  });

  it('不可恢复（planned）时 --confirm --run 退出码 1 且无桥接载荷', async () => {
    const repo = await makeRepo();
    const created = await runMissionCommand(['create', '--objective', 'o'], repo, store);
    const id = /mission-[0-9a-z-]+/.exec(created.stdout ?? '')![0];
    const res = await runMissionCommand(['resume', id, '--confirm', '--run'], repo, store);
    expect(res.code).toBe(1);
    expect(res.continueRun).toBeUndefined();
  });
});

describe('buildContinuationPrompt（纯函数）', () => {
  it('无漂移无告警时不虚构漂移/告警段；仍在的未决项如实保留', () => {
    // 检查点 HEAD 与当前一致且工作区干净 → drift 为 none；manifest 带接受标准且未验证
    // → 「接受标准尚未执行」仍在未决项里（这是诚实的，不该被 prompt 合成吞掉）。
    const ckpt = ev(1, { type: 'checkpoint.created', checkpointId: 'cp-1', label: 'x', gitHead: 'aaa1111' });
    const plan = buildRecoveryPlan({ view: viewOf([ckpt]), health: { corruptLines: 0 }, git: CLEAN });
    expect(plan.drift?.kind).toBe('none');
    const p = buildContinuationPrompt(plan);
    expect(p).toContain('resuming an unfinished engineering task');
    expect(p).not.toContain('# Repository drift');
    expect(p).not.toContain('# Log health warnings');
    expect(p).toContain('# Items needing attention');
    expect(p).toContain('step mission verify');
  });

  it('漂移、未决项、告警各自成段且条目原样进入', () => {
    const plan = buildRecoveryPlan({
      view: viewOf([
        ev(1, { type: 'mission.created', repo: '/r', objective: 'o', acceptanceCount: 0 }),
        ev(2, { type: 'checkpoint.created', checkpointId: 'cp-001', label: 'x', gitHead: 'a'.repeat(40), dirty: true }),
      ]),
      health: { corruptLines: 2 },
      git: { available: true, head: 'b'.repeat(40), dirty: false, committedChanges: ['src/a.ts'], uncommittedChanges: [] },
    });
    const p = buildContinuationPrompt(plan);
    expect(p).toContain('# Repository drift (committed)');
    expect(p).toContain('src/a.ts');
    expect(p).toContain('# Items needing attention'); // 脏检查点进未决项
    expect(p).toContain('# Log health warnings');
    expect(p).toContain('2 行无法解析');
  });
});

describe('mission resume 副作用账本（真会话）', () => {
  it('悬空的 write_file 进需要确认；账本计数出现在关联会话行', async () => {
    const repo = await makeRepo();
    const ss = new SessionStore();
    const s = ss.create(repo, 'test-model');
    ss.appendFull(repo, s.id, [
      stored({ role: 'user', content: '修复扣款' }, { kind: 'user' }),
      stored(
        { role: 'assistant', content: [textBlock('开写'), toolUseBlock('c1', 'write_file', { path: 'src/payment.ts' })] },
        { kind: 'assistant' },
      ),
      // c1 无结果：进程死在副作用中途
    ]);
    const id = await makeRunningMission(repo, ['--session', s.id]);
    await runMissionCommand(['checkpoint', id, '--label', 'base'], repo, store);
    const res = await runMissionCommand(['resume', id], repo, store);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('1 笔副作用（1 未闭环）');
    expect(res.stdout).toContain('未闭环');
    expect(res.stdout).toContain('src/payment.ts');
    expect(res.stdout).toContain('半写状态');
  });

  it('已完成的副作用不告警；已失败的进告警（失败也是事实）', async () => {
    const repo = await makeRepo();
    const ss = new SessionStore();
    const s = ss.create(repo, 'test-model');
    ss.appendFull(repo, s.id, [
      stored({ role: 'user', content: '任务' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [toolUseBlock('c1', 'write_file', { path: 'src/ok.ts' })] }, { kind: 'assistant' }),
      stored({ role: 'user', content: [toolResultBlock('c1', 'wrote 10 bytes')] }, { kind: 'tool' }),
      stored({ role: 'assistant', content: [toolUseBlock('c2', 'bash', { command: 'pnpm test' })] }, { kind: 'assistant' }),
      stored({ role: 'user', content: [toolResultBlock('c2', 'tests failed', true)] }, { kind: 'tool' }),
    ]);
    const id = await makeRunningMission(repo, ['--session', s.id]);
    await runMissionCommand(['checkpoint', id, '--label', 'base'], repo, store);
    const res = await runMissionCommand(['resume', id], repo, store);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('2 笔副作用（0 未闭环）');
    expect(res.stdout).toContain('已失败');
    expect(res.stdout).toContain('pnpm test');
    expect(res.stdout).not.toContain('未闭环（最近'); // 无未闭环条目
  });
});
