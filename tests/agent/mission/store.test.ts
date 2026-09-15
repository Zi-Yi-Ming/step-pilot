import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissionStore, newMissionId, parseEventLine } from '../../../src/agent/mission/store.js';
import { runMissionCommand } from '../../../src/agent/mission/cli.js';

const REPO = '/fake/repo';

let baseDir: string;
let store: MissionStore;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'mission-test-'));
  store = new MissionStore(baseDir);
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('MissionStore：创建与载入', () => {
  it('create 写入 manifest 与首条 mission.created 事件', () => {
    const m = store.create({
      repo: REPO,
      objective: '修复重复扣款',
      acceptance: [{ command: 'pnpm vitest run', expectExit: 0 }],
    });
    expect(m.missionId).toMatch(/^mission-/);
    expect(m.manifestVersion).toBe(1);
    const view = store.load(REPO, m.missionId);
    expect(view).not.toBeNull();
    expect(view!.manifest.objective).toBe('修复重复扣款');
    expect(view!.events).toHaveLength(1);
    expect(view!.events[0]!.type).toBe('mission.created');
    expect(view!.events[0]!.seq).toBe(1);
    expect(view!.state.status).toBe('planned');
    expect(view!.state.eventCount).toBe(1);
  });

  it('create 拒绝覆盖同名 Mission（不静默销毁既有事实链）', () => {
    const m = store.create({ repo: REPO, objective: 'a', acceptance: [], missionId: 'mission-fixed' });
    expect(m.missionId).toBe('mission-fixed');
    expect(() => store.create({ repo: REPO, objective: 'b', acceptance: [], missionId: 'mission-fixed' })).toThrow(/已存在/);
  });

  it('appendEvent 的 seq 递增，且 ts / eventId 由 store 补齐', () => {
    const m = store.create({ repo: REPO, objective: 'o', acceptance: [] });
    const e2 = store.appendEvent(REPO, m.missionId, { type: 'mission.status_changed', from: 'planned', to: 'running' });
    const e3 = store.appendEvent(REPO, m.missionId, { type: 'checkpoint.created', checkpointId: 'cp-1', label: '改完' });
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
    expect(e2.eventId).toMatch(/^evt-/);
    expect(e2.missionId).toBe(m.missionId);
    expect(e2.attemptId).toBe('attempt-1');
    const view = store.load(REPO, m.missionId);
    expect(view!.state.status).toBe('running');
    expect(view!.state.checkpointCount).toBe(1);
  });

  it('load 对不存在的 Mission 返回 null', () => {
    expect(store.load(REPO, 'mission-nope')).toBeNull();
    expect(store.loadManifest(REPO, 'mission-nope')).toBeNull();
  });

  it('有 manifest 但无事件日志时：返回 planned 空态，不伪造进度', () => {
    const m = store.create({ repo: REPO, objective: 'o', acceptance: [] });
    rmSync(store.eventsPath(REPO, m.missionId), { force: true });
    const view = store.load(REPO, m.missionId);
    expect(view!.events).toHaveLength(0);
    expect(view!.state.status).toBe('planned');
    expect(view!.state.checkpointCount).toBe(0);
  });

  it('missionId 不同仓库互不干扰（按 repo 分桶）', () => {
    const a = store.create({ repo: '/repo/a', objective: 'A', acceptance: [] });
    const b = store.create({ repo: '/repo/b', objective: 'B', acceptance: [] });
    expect(store.list('/repo/a').map((x) => x.missionId)).toEqual([a.missionId]);
    expect(store.list('/repo/b').map((x) => x.missionId)).toEqual([b.missionId]);
  });
});

describe('MissionStore：日志容错与健康告警', () => {
  it('损坏行被跳过并计数，status 仍然可用', () => {
    const m = store.create({ repo: REPO, objective: 'o', acceptance: [] });
    store.appendEvent(REPO, m.missionId, { type: 'mission.status_changed', from: 'planned', to: 'running' });
    writeFileSync(store.eventsPath(REPO, m.missionId), 'this is not json\n', { flag: 'a' });
    const view = store.load(REPO, m.missionId);
    expect(view!.health.corruptLines).toBe(1);
    expect(view!.events).toHaveLength(2);
    expect(view!.state.status).toBe('running');
  });

  it('日志有缺口时 findSeqGaps 可检出（seq 取最大序号 +1，不复用已用序号）', () => {
    const m = store.create({ repo: REPO, objective: 'o', acceptance: [] });
    // 手工把第二条事件改成 seq=5，制造缺口
    const path = store.eventsPath(REPO, m.missionId);
    const first = readFileSync(path, 'utf8');
    writeFileSync(path, `${first}${JSON.stringify({ eventId: 'e', seq: 5, ts: 'x', missionId: m.missionId, attemptId: 'attempt-1', type: 'checkpoint.created', checkpointId: 'cp-x', label: 'l' })}\n`);
    const next = store.appendEvent(REPO, m.missionId, { type: 'mission.status_changed', from: 'planned', to: 'running' });
    expect(next.seq).toBe(6);
  });

  it('parseEventLine 拒绝垃圾输入与缺 seq 的行', () => {
    expect(parseEventLine('')).toBeNull();
    expect(parseEventLine('not json')).toBeNull();
    expect(parseEventLine('[1,2]')).toBeNull();
    expect(parseEventLine('{"type":"checkpoint.created"}')).toBeNull();
    expect(parseEventLine('{"type":"checkpoint.created","seq":1}')).not.toBeNull();
  });
});

describe('MissionStore：列表', () => {
  it('list 按 createdAt 倒序返回，且跳过损坏 manifest', () => {
    const older = store.create({ repo: REPO, objective: 'old', acceptance: [], missionId: 'mission-old', now: () => new Date('2026-01-01T00:00:00Z') });
    const newer = store.create({ repo: REPO, objective: 'new', acceptance: [], missionId: 'mission-new', now: () => new Date('2026-06-01T00:00:00Z') });
    writeFileSync(join(store.dirFor(REPO), 'broken.json'), '{ not json');
    const list = store.list(REPO);
    expect(list.map((m) => m.missionId)).toEqual([newer.missionId, older.missionId]);
  });

  it('无 Mission 时 list 返回空数组', () => {
    expect(store.list('/empty/repo')).toEqual([]);
  });

  it('newMissionId 带 mission- 前缀且互不相同', () => {
    const ids = new Set([newMissionId(), newMissionId(), newMissionId()]);
    expect(ids.size).toBe(3);
    for (const id of ids) expect(id.startsWith('mission-')).toBe(true);
  });
});

describe('mission 无头命令', () => {
  it('未知子命令返回退出码 1 并给出用法', async () => {
    const res = await runMissionCommand(['bogus'], REPO, store);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('未知 mission 子命令');
  });

  it('未实现的 verify / prove 明确返回退出码 2，不假装成功', async () => {
    for (const sub of ['verify', 'prove']) {
      const res = await runMissionCommand([sub, 'mission-x'], REPO, store);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('尚未实现');
    }
  });

  it('create → status → replay 走通，且 replay 明示只读', async () => {
    const create = await runMissionCommand(
      ['create', '--objective', '修复重复扣款', '--acceptance', 'pnpm vitest run'],
      REPO,
      store,
    );
    expect(create.code).toBe(0);
    const id = /mission-[0-9a-z-]+/.exec(create.stdout ?? '')![0];

    const status = await runMissionCommand(['status', id], REPO, store);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('status:       planned');
    expect(status.stdout).toContain('verification: pending');

    const replay = await runMissionCommand(['replay', id], REPO, store);
    expect(replay.code).toBe(0);
    expect(replay.stdout).toContain('只读重放');
    expect(replay.stdout).toContain('mission.created');

    const show = await runMissionCommand(['show', id], REPO, store);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('pnpm vitest run  (expect exit 0)');
  });

  it('缺少 --objective 时拒绝创建（目标不能为空）', async () => {
    const res = await runMissionCommand(['create', '--acceptance', 'x'], REPO, store);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--objective');
  });

  it('create 未给接受标准时明确提示：没有机器依据不应判完成', async () => {
    const res = await runMissionCommand(['create', '--objective', 'o'], REPO, store);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('未提供接受标准');
  });

  it('--acceptance 只在末尾的 :<数字> 上切分，命令内的冒号不被切坏', async () => {
    const create = await runMissionCommand(
      ['create', '--objective', 'o', '--acceptance', 'bash -c "a:b":2'],
      REPO,
      store,
    );
    expect(create.code).toBe(0);
    const id = /mission-[0-9a-z-]+/.exec(create.stdout ?? '')![0];
    const show = await runMissionCommand(['show', id], REPO, store);
    expect(show.stdout).toContain('bash -c "a:b"  (expect exit 2)');
  });

  it('未知选项被拒绝（不静默忽略笔误）', async () => {
    const res = await runMissionCommand(['create', '--objective', 'o', '--bogus', '1'], REPO, store);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('未知选项');
  });

  it('status 对伪造的 completed 状态给出告警（不采信无验证的完成态）', async () => {
    const create = await runMissionCommand(['create', '--objective', 'o'], REPO, store);
    const id = /mission-[0-9a-z-]+/.exec(create.stdout ?? '')![0];
    // 直接往日志塞一条绕过验证的 status_changed → completed
    const path = store.eventsPath(REPO, id);
    writeFileSync(
      path,
      `${readFileSync(path, 'utf8')}${JSON.stringify({ eventId: 'e9', seq: 2, ts: 'x', missionId: id, attemptId: 'attempt-1', type: 'mission.status_changed', from: 'planned', to: 'completed' })}\n`,
    );
    const status = await runMissionCommand(['status', id], REPO, store);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('非法状态迁移被跳过');
    expect(status.stdout).toContain('status:       planned'); // 状态没有被伪造成 completed
  });

  it('replay 对不存在的 Mission 返回退出码 1', async () => {
    const res = await runMissionCommand(['replay', 'mission-missing'], REPO, store);
    expect(res.code).toBe(1);
  });
});

describe('写入侧校验：非法迁移不落盘', () => {
  it('appendEvent 对非法迁移抛错，且事实源长度不变', () => {
    const m = store.create({ repo: REPO, objective: 'o', acceptance: [] });
    const before = store.load(REPO, m.missionId)!.events.length;
    // planned → verifying 非法
    expect(() =>
      store.appendEvent(REPO, m.missionId, { type: 'mission.status_changed', from: 'planned', to: 'verifying' }),
    ).toThrow(/非法 Mission 状态迁移/);
    expect(store.load(REPO, m.missionId)!.events.length).toBe(before);
  });

  it('appendEvent 拒绝 status_changed 直接置 completed（不落盘）', () => {
    const m = store.create({ repo: REPO, objective: 'o', acceptance: [] });
    store.appendEvent(REPO, m.missionId, { type: 'mission.status_changed', from: 'planned', to: 'running' });
    store.appendEvent(REPO, m.missionId, { type: 'mission.status_changed', from: 'running', to: 'verifying' });
    const before = store.load(REPO, m.missionId)!.events.length;
    expect(() =>
      store.appendEvent(REPO, m.missionId, { type: 'mission.status_changed', from: 'verifying', to: 'completed' }),
    ).toThrow();
    const view = store.load(REPO, m.missionId)!;
    expect(view.events.length).toBe(before);
    expect(view.state.status).toBe('verifying');
  });

  it('appendEvent 对不存在的 Mission 抛错', () => {
    expect(() =>
      store.appendEvent(REPO, 'mission-nope', { type: 'mission.status_changed', from: 'planned', to: 'running' }),
    ).toThrow(/不存在/);
  });

  it('verification.completed(passed) 是唯一能落盘的 completed 入口', () => {
    const m = store.create({ repo: REPO, objective: 'o', acceptance: [] });
    store.appendEvent(REPO, m.missionId, { type: 'mission.status_changed', from: 'planned', to: 'running' });
    store.appendEvent(REPO, m.missionId, { type: 'mission.status_changed', from: 'running', to: 'verifying' });
    store.appendEvent(REPO, m.missionId, { type: 'verification.completed', verifierId: 'vitest', passed: true });
    const view = store.load(REPO, m.missionId)!;
    expect(view.state.status).toBe('completed');
    expect(view.state.lastVerification?.passed).toBe(true);
    expect(view.state.skippedTransitions).toBe(0); // 全是合法迁移，一条都没被跳过
  });
});

describe('mission 生命周期命令 start / pause / stop', () => {
  it('start 把 planned 推到 running', async () => {
    const created = await runMissionCommand(['create', '--objective', 'o'], REPO, store);
    const id = /mission-[0-9a-z-]+/.exec(created.stdout ?? '')![0];
    const res = await runMissionCommand(['start', id, '--reason', '开工'], REPO, store);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('planned → running');
    expect(store.load(REPO, id)!.state.status).toBe('running');
    expect(store.load(REPO, id)!.state.lastReason).toBe('开工');
  });

  it('pause 只对 running 合法；重复 pause 被拒绝且不写盘', async () => {
    const created = await runMissionCommand(['create', '--objective', 'o'], REPO, store);
    const id = /mission-[0-9a-z-]+/.exec(created.stdout ?? '')![0];
    await runMissionCommand(['start', id], REPO, store);
    expect((await runMissionCommand(['pause', id], REPO, store)).code).toBe(0);
    const before = store.load(REPO, id)!.events.length;
    const again = await runMissionCommand(['pause', id], REPO, store);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('无需迁移');
    expect(store.load(REPO, id)!.events.length).toBe(before);
  });

  it('stop 是终态：之后再 start 被拒绝', async () => {
    const created = await runMissionCommand(['create', '--objective', 'o'], REPO, store);
    const id = /mission-[0-9a-z-]+/.exec(created.stdout ?? '')![0];
    await runMissionCommand(['start', id], REPO, store);
    expect((await runMissionCommand(['stop', id], REPO, store)).code).toBe(0);
    const res = await runMissionCommand(['start', id], REPO, store);
    expect(res.code).toBe(1);
    expect(store.load(REPO, id)!.state.status).toBe('stopped');
  });

  it('planned 上直接 stop 合法（放弃未开始的任务）', async () => {
    const created = await runMissionCommand(['create', '--objective', 'o'], REPO, store);
    const id = /mission-[0-9a-z-]+/.exec(created.stdout ?? '')![0];
    expect((await runMissionCommand(['stop', id], REPO, store)).code).toBe(0);
  });

  it('start 缺少 id 时给出用法', async () => {
    const res = await runMissionCommand(['start'], REPO, store);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('usage: step mission start');
  });
});
