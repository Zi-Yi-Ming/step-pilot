import { describe, expect, it } from 'vitest';
import {
  applyMissionEvent,
  canTransition,
  emptyMissionState,
  findSeqGaps,
  isTerminal,
  MissionTransitionError,
  replayMissionEvents,
} from '../../../src/agent/mission/state.js';
import type { MissionEvent, MissionStatus } from '../../../src/agent/mission/types.js';

const TS = '2026-09-14T00:00:00.000Z';
const MID = 'mission-test-1';

/** 造一条带完整信封的事件（只补 seq 与载荷）。 */
function ev(seq: number, payload: Omit<MissionEvent, 'eventId' | 'seq' | 'ts' | 'missionId' | 'attemptId'>): MissionEvent {
  return { eventId: `evt-${seq}`, seq, ts: TS, missionId: MID, attemptId: 'attempt-1', ...payload } as MissionEvent;
}

function statusChange(seq: number, from: MissionStatus, to: MissionStatus, reason?: string): MissionEvent {
  return ev(seq, reason === undefined ? { type: 'mission.status_changed', from, to } : { type: 'mission.status_changed', from, to, reason });
}

describe('Mission 状态机：迁移表', () => {
  it('completed 与 stopped 是终态，没有任何出边', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('stopped')).toBe(true);
    for (const to of ['planned', 'running', 'paused', 'recovering', 'verifying', 'failed', 'blocked'] as MissionStatus[]) {
      expect(canTransition('completed', to)).toBe(false);
      expect(canTransition('stopped', to)).toBe(false);
    }
  });

  it('failed 与 blocked 不是终态：它们的出边承载 resume 语义', () => {
    expect(isTerminal('failed')).toBe(false);
    expect(isTerminal('blocked')).toBe(false);
    expect(canTransition('failed', 'running')).toBe(true);
    expect(canTransition('failed', 'recovering')).toBe(true);
    expect(canTransition('blocked', 'running')).toBe(true);
  });

  it('planned 不能直接跳到 completed 或 verifying', () => {
    expect(canTransition('planned', 'completed')).toBe(false);
    expect(canTransition('planned', 'verifying')).toBe(false);
    expect(canTransition('planned', 'running')).toBe(true);
  });

  it('同状态迁移视为合法（幂等重放）', () => {
    expect(canTransition('running', 'running')).toBe(true);
    expect(canTransition('failed', 'failed')).toBe(true);
  });
});

describe('Mission 状态机：applyMissionEvent', () => {
  it('status_changed 一律拒绝直接置 completed（模型自报不算完成）', () => {
    const state = emptyMissionState();
    state.status = 'verifying';
    expect(() => applyMissionEvent(state, statusChange(2, 'verifying', 'completed'))).toThrow(MissionTransitionError);
  });

  it('非法迁移抛错，且状态不被改动', () => {
    const state = emptyMissionState();
    state.status = 'planned';
    expect(() => applyMissionEvent(state, statusChange(2, 'planned', 'verifying'))).toThrow(MissionTransitionError);
    expect(state.status).toBe('planned');
  });

  it('合法迁移改写状态并记录 reason', () => {
    const state = emptyMissionState();
    applyMissionEvent(state, statusChange(2, 'planned', 'running', '开始执行'));
    expect(state.status).toBe('running');
    expect(state.lastReason).toBe('开始执行');
  });

  it('verification.completed(passed) 从 verifying 推进到 completed 并记录验证结果', () => {
    const state = emptyMissionState();
    applyMissionEvent(state, statusChange(2, 'planned', 'running'));
    applyMissionEvent(state, statusChange(3, 'running', 'verifying'));
    applyMissionEvent(state, ev(4, { type: 'verification.completed', verifierId: 'vitest', passed: true }));
    expect(state.status).toBe('completed');
    expect(state.lastVerification).toEqual({ verifierId: 'vitest', passed: true, ts: TS });
  });

  it('verification.completed 失败 → failed（不是 completed，也不是环境故障）', () => {
    const state = emptyMissionState();
    applyMissionEvent(state, statusChange(2, 'planned', 'running'));
    applyMissionEvent(state, statusChange(3, 'running', 'verifying'));
    applyMissionEvent(state, ev(4, { type: 'verification.completed', verifierId: 'vitest', passed: false }));
    expect(state.status).toBe('failed');
    expect(state.lastVerification?.passed).toBe(false);
  });

  it('verification.completed 在 planned 上不合法 → 抛错', () => {
    const state = emptyMissionState();
    expect(() => applyMissionEvent(state, ev(2, { type: 'verification.completed', verifierId: 'v', passed: true }))).toThrow(
      MissionTransitionError,
    );
  });

  it('checkpoint 与 recovery 分别计数，且 checkpoint 记录最近 id', () => {
    const state = emptyMissionState();
    // recovery.started 现在是真实状态迁移（→ recovering），所以必须先离开 planned
    applyMissionEvent(state, statusChange(2, 'planned', 'running'));
    applyMissionEvent(state, ev(3, { type: 'checkpoint.created', checkpointId: 'cp-1', label: '改完 payment.ts' }));
    applyMissionEvent(state, ev(4, { type: 'checkpoint.created', checkpointId: 'cp-2', label: '单测通过' }));
    applyMissionEvent(state, ev(5, { type: 'recovery.started', fromCheckpointId: 'cp-2', reason: 'process_restart' }));
    expect(state.status).toBe('recovering');
    applyMissionEvent(state, ev(6, { type: 'recovery.completed', replayedEvents: 42 }));
    expect(state.status).toBe('running');
    expect(state.checkpointCount).toBe(2);
    expect(state.lastCheckpointId).toBe('cp-2');
    // recovery.completed 不重复累计
    expect(state.recoveryCount).toBe(1);
  });

  it('recovery.started 是状态迁移：planned 上没有可恢复的东西，直接抛错', () => {
    const state = emptyMissionState();
    expect(() => applyMissionEvent(state, ev(2, { type: 'recovery.started', reason: 'x' }))).toThrow(MissionTransitionError);
    expect(state.status).toBe('planned');
    expect(state.recoveryCount).toBe(0);
  });

  it('终态不可恢复：completed / stopped 上的 recovery.started 抛错', () => {
    for (const terminal of ['completed', 'stopped'] as MissionStatus[]) {
      const state = emptyMissionState();
      state.status = terminal;
      expect(() => applyMissionEvent(state, ev(2, { type: 'recovery.started', reason: 'x' }))).toThrow(MissionTransitionError);
      expect(state.status).toBe(terminal);
    }
  });

  it('paused 与 verifying 允许进入 recovering（进程可能死在暂停期或验证期）', () => {
    for (const from of ['paused', 'verifying'] as MissionStatus[]) {
      const state = emptyMissionState();
      state.status = from;
      applyMissionEvent(state, ev(2, { type: 'recovery.started', reason: 'process_restart' }));
      expect(state.status).toBe('recovering');
    }
  });

  it('recovery.completed 回到 running，而不是退回恢复前的失败态', () => {
    const state = emptyMissionState();
    state.status = 'failed';
    applyMissionEvent(state, ev(2, { type: 'recovery.started', reason: 'process_restart' }));
    applyMissionEvent(state, ev(3, { type: 'recovery.completed', replayedEvents: 7 }));
    expect(state.status).toBe('running');
  });

  it('checkpoint 可携带 git 元数据，且脏检查点被如实记录', () => {
    const state = emptyMissionState();
    applyMissionEvent(
      state,
      ev(2, {
        type: 'checkpoint.created',
        checkpointId: 'cp-1',
        label: '脏工作区上的检查点',
        gitHead: 'a1b2c3d4',
        changedFiles: ['src/a.ts'],
        dirty: true,
      }),
    );
    expect(state.checkpointCount).toBe(1);
    expect(state.lastCheckpointId).toBe('cp-1');
  });

  it('mission.created 不改变状态，只登记事件', () => {
    const state = emptyMissionState();
    applyMissionEvent(state, ev(1, { type: 'mission.created', repo: '/repo', objective: '修 bug', acceptanceCount: 1 }));
    expect(state.status).toBe('planned');
    expect(state.eventCount).toBe(1);
  });
});

describe('Mission 状态机：replayMissionEvents 容错', () => {
  it('非法迁移被跳过并计数，不抛错（读日志必须容错）', () => {
    const events = [
      ev(1, { type: 'mission.created', repo: '/r', objective: 'o', acceptanceCount: 0 }),
      statusChange(2, 'planned', 'running'),
      statusChange(3, 'running', 'planned'), // 非法：running 不能回到 planned
      statusChange(4, 'running', 'verifying'),
    ];
    const state = replayMissionEvents(events);
    expect(state.status).toBe('verifying');
    expect(state.skippedTransitions).toBe(1);
    expect(state.eventCount).toBe(4);
  });

  it('status_changed 直接置 completed 的伪造事件被跳过，不会伪装成完成', () => {
    const events = [
      ev(1, { type: 'mission.created', repo: '/r', objective: 'o', acceptanceCount: 0 }),
      statusChange(2, 'planned', 'running'),
      statusChange(3, 'running', 'completed'), // 伪造：绕过验证
    ];
    const state = replayMissionEvents(events);
    expect(state.status).toBe('running');
    expect(state.skippedTransitions).toBe(1);
    expect(state.lastVerification).toBeUndefined();
  });

  it('重放是纯函数：同一序列重放两次结果一致，且不修改输入事件', () => {
    const events = [
      ev(1, { type: 'mission.created', repo: '/r', objective: 'o', acceptanceCount: 1 }),
      statusChange(2, 'planned', 'running'),
      ev(3, { type: 'checkpoint.created', checkpointId: 'cp-1', label: 'x' }),
    ];
    const snapshot = JSON.stringify(events);
    const a = replayMissionEvents(events);
    const b = replayMissionEvents(events);
    expect(a).toEqual(b);
    expect(JSON.stringify(events)).toBe(snapshot);
  });

  it('空事件序列返回初始态（不伪造任何进度）', () => {
    const state = replayMissionEvents([]);
    expect(state.status).toBe('planned');
    expect(state.eventCount).toBe(0);
    expect(state.checkpointCount).toBe(0);
  });
});

describe('Mission 事件序号缺口检测', () => {
  it('连续序号无缺口', () => {
    expect(findSeqGaps([ev(1, { type: 'recovery.completed', replayedEvents: 0 }), ev(2, { type: 'recovery.completed', replayedEvents: 0 })])).toEqual([]);
  });

  it('缺号被列出（日志被截断或外部改写）', () => {
    const events = [ev(1, { type: 'recovery.completed', replayedEvents: 0 }), ev(4, { type: 'recovery.completed', replayedEvents: 0 })];
    expect(findSeqGaps(events)).toEqual([2, 3]);
  });

  it('缺口数量受 limit 限制，不会无限展开', () => {
    const events = [ev(1, { type: 'recovery.completed', replayedEvents: 0 }), ev(100, { type: 'recovery.completed', replayedEvents: 0 })];
    expect(findSeqGaps(events, 3)).toEqual([2, 3, 4]);
  });
});
