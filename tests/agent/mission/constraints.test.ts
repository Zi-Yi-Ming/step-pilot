/**
 * Mission 约束钉扎测试。
 *
 * 两层：
 * - buildMissionConstraintBlock（纯函数）：注入段内容——目标/验收/范围齐全、诚实性
 *   声明（完成判定只归 verify、状态是快照）必须在。
 * - findSessionMission：会话关联查找——终态跳过、最近优先、无关联返回 undefined。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildMissionConstraintBlock, findSessionMission } from '../../../src/agent/mission/constraints.js';
import { MissionStore } from '../../../src/agent/mission/store.js';
import type { MissionManifest } from '../../../src/agent/mission/types.js';

let baseDir: string;
let store: MissionStore;
const tmpDirs: string[] = [];

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'mission-constraints-'));
  tmpDirs.push(baseDir);
  store = new MissionStore(baseDir);
});

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

function makeManifest(over: Partial<MissionManifest>): MissionManifest {
  return {
    manifestVersion: 1,
    missionId: 'mission-x',
    repo: '/repo',
    objective: '修复重复扣款',
    acceptance: [{ command: 'pnpm vitest run', expectExit: 0 }],
    policy: {},
    createdAt: '2026-09-19T00:00:00.000Z',
    ...over,
  };
}

describe('buildMissionConstraintBlock', () => {
  it('含目标、验收命令、范围 glob 与 verify 判定声明', () => {
    const m = makeManifest({
      missionId: 'mission-abc',
      scope: { allowFiles: ['src/payment/**', 'src/payment.test.ts'] },
      acceptance: [
        { command: 'pnpm vitest run', expectExit: 0 },
        { command: 'pnpm build', expectExit: 0, description: '构建通过' },
      ],
    });
    const block = buildMissionConstraintBlock(m, 'running');
    expect(block).toContain('## Associated Mission (pinned constraints)');
    expect(block).toContain('修复重复扣款');
    expect(block).toContain('`pnpm vitest run` (expect exit 0)');
    expect(block).toContain('`pnpm build` (expect exit 0) — 构建通过');
    expect(block).toContain('src/payment/**');
    expect(block).toContain('src/payment.test.ts');
    expect(block).toContain('do NOT declare completion yourself');
    expect(block).toContain('step mission verify mission-abc');
    expect(block).toContain('running');
    expect(block).toContain('survive context compaction'); // 钉扎语义明示
  });

  it('无范围时不出 scope 行；无验收时如实说明不得判完成', () => {
    const block = buildMissionConstraintBlock(makeManifest({ acceptance: [] }), 'paused');
    expect(block).not.toContain('Scope');
    expect(block).toContain('none recorded yet');
    expect(block).toContain('must not be judged complete');
    expect(block).toContain('paused');
  });
});

describe('findSessionMission', () => {
  it('按 sessionId 关联，非终态优先取最近创建', () => {
    const old = store.create({
      repo: '/repo', objective: 'old', acceptance: [], sessionId: 's1',
      missionId: 'mission-old', now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const newer = store.create({
      repo: '/repo', objective: 'newer', acceptance: [], sessionId: 's1',
      missionId: 'mission-newer', now: () => new Date('2026-06-01T00:00:00Z'),
    });
    const ref = findSessionMission(store, '/repo', 's1');
    expect(ref?.manifest.missionId).toBe(newer.missionId);
    expect(ref?.status).toBe('planned');
    expect(old.missionId).not.toBe(newer.missionId);
  });

  it('终态（stopped/completed）Mission 不注入，回落到更早的非终态', () => {
    const older = store.create({
      repo: '/repo', objective: 'older', acceptance: [], sessionId: 's2',
      missionId: 'mission-older', now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const stopped = store.create({
      repo: '/repo', objective: 'done', acceptance: [], sessionId: 's2',
      missionId: 'mission-stopped', now: () => new Date('2026-06-01T00:00:00Z'),
    });
    store.appendEvent('/repo', stopped.missionId, { type: 'mission.status_changed', from: 'planned', to: 'stopped' });
    const ref = findSessionMission(store, '/repo', 's2');
    expect(ref?.manifest.missionId).toBe(older.missionId);
    expect(ref?.status).toBe('planned');
  });

  it('全部终态或无关联时返回 undefined', () => {
    const only = store.create({
      repo: '/repo', objective: 'o', acceptance: [], sessionId: 's3',
      missionId: 'mission-only', now: () => new Date('2026-06-01T00:00:00Z'),
    });
    store.appendEvent('/repo', only.missionId, { type: 'mission.status_changed', from: 'planned', to: 'stopped' });
    expect(findSessionMission(store, '/repo', 's3')).toBeUndefined();
    expect(findSessionMission(store, '/repo', 's-none')).toBeUndefined();
    expect(findSessionMission(store, '/other-repo', 's3')).toBeUndefined();
  });
});
