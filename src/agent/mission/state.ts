/**
 * Mission 状态机（纯函数）。
 *
 * 两条纪律：
 * 1. **live 与 replay 共用同一份迁移逻辑**——不存在「写入时一套、恢复时另一套」，
 *    否则两套会随时间漂移（这条是照搬 wirelog.ts 的经验）。
 * 2. **completed 不能由 status_changed 直接置位**——只能由 verification.completed(passed=true)
 *    触发。这是「模型自报完成不算完成」在代码层面的落点，而不是只写在文档里。
 *
 * 容错分层：
 * - `applyMissionEvent()` 对非法迁移抛错，供**写入前**校验，保证盘上不出现非法事件。
 * - `replayMissionEvents()` 跳过非法迁移并计数，供**读取**使用，保证坏日志不会炸掉 status。
 */
import type { MissionAttemptState, MissionEvent, MissionStatus } from './types.js';

/** 非法状态迁移。写入前校验失败时抛出，避免把非法事件持久化。 */
export class MissionTransitionError extends Error {
  constructor(
    readonly from: MissionStatus,
    readonly to: MissionStatus,
  ) {
    super(`非法 Mission 状态迁移：${from} → ${to}`);
    this.name = 'MissionTransitionError';
  }
}

/**
 * 合法迁移表。
 *
 * 读法：`failed` / `blocked` 不是终态——它们的出边就是「resume 语义」的载体。
 * `completed` / `stopped` 无出边：终态不可自动复活，要再来一次就新建 Mission。
 */
const LEGAL_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  // planned 没有 recovering 出边：还没开始执行的任务没有东西可恢复。
  planned: ['running', 'blocked', 'stopped'],
  running: ['paused', 'recovering', 'verifying', 'failed', 'blocked', 'stopped'],
  // paused / verifying 都允许进入 recovering：进程可能在暂停期间或验证期间死掉，
  // 那正是需要「重建事实链再继续」的场景。
  paused: ['running', 'recovering', 'blocked', 'stopped'],
  // 恢复完成后回到 running 继续推进，或直接进入 verifying（恢复点本身就在验证前）
  recovering: ['running', 'verifying', 'failed', 'blocked', 'stopped'],
  verifying: ['completed', 'failed', 'blocked', 'running', 'recovering', 'stopped'],
  // 非终态：允许 resume
  failed: ['running', 'recovering', 'blocked', 'stopped'],
  blocked: ['running', 'recovering', 'paused', 'stopped'],
  completed: [],
  stopped: [],
};

/** 是否允许 from → to。同状态视为允许（幂等重放）。 */
export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  if (from === to) return true;
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** 是否为终态（不可再迁移）。 */
export function isTerminal(status: MissionStatus): boolean {
  return status === 'completed' || status === 'stopped';
}

/** 全部合法迁移表（只读快照，供 CLI / 文档 / 测试展示）。 */
export function legalTransitions(): Readonly<Record<MissionStatus, readonly MissionStatus[]>> {
  return LEGAL_TRANSITIONS;
}

/** 新建 Mission 的初始派生状态。 */
export function emptyMissionState(): MissionAttemptState {
  return { status: 'planned', checkpointCount: 0, recoveryCount: 0, eventCount: 0, skippedTransitions: 0 };
}

/** 状态变更事件的载荷（供 store 构造事件用）。 */
export interface StatusChange {
  from: MissionStatus;
  to: MissionStatus;
  reason?: string;
}

/**
 * 校验一次状态变更是否合法，非法则抛错。写入前调用。
 *
 * `to === 'completed'` 一律拒绝：completed 是验证结果的**结论**，不是可以主动声明的状态。
 */
export function assertStatusChange(from: MissionStatus, to: MissionStatus): void {
  if (to === 'completed') {
    throw new MissionTransitionError(from, to);
  }
  if (!canTransition(from, to)) {
    throw new MissionTransitionError(from, to);
  }
}

/**
 * 单步状态迁移（纯函数，原地修改 state，不产生任何副作用）。
 *
 * @throws MissionTransitionError 非法迁移（含 status_changed 直接置 completed）
 */
export function applyMissionEvent(state: MissionAttemptState, event: MissionEvent): void {
  state.eventCount += 1;
  switch (event.type) {
    case 'mission.created':
      // 首个事件：状态保持 planned，仅登记事件
      break;
    case 'mission.status_changed': {
      assertStatusChange(event.from, event.to);
      state.status = event.to;
      if (event.reason !== undefined) state.lastReason = event.reason;
      break;
    }
    case 'checkpoint.created':
      state.lastCheckpointId = event.checkpointId;
      state.checkpointCount += 1;
      break;
    case 'recovery.started': {
      // 恢复是一次真实的状态迁移，不是单纯的计数器：
      // 「正在从 checkpoint 重建」与「正在执行」是两种不同的处境，状态栏要能区分。
      if (!canTransition(state.status, 'recovering')) {
        throw new MissionTransitionError(state.status, 'recovering');
      }
      state.status = 'recovering';
      state.recoveryCount += 1;
      if (event.fromCheckpointId !== undefined) state.lastCheckpointId = event.fromCheckpointId;
      break;
    }
    case 'recovery.completed': {
      // 重建完成 → 回到 running 等待继续推进。
      // 注意这里**不**恢复成恢复前的状态：恢复前可能是 failed/blocked，
      // 回到那些状态等于宣称「还没恢复」，与刚记录的事实矛盾。
      if (!canTransition(state.status, 'running')) {
        throw new MissionTransitionError(state.status, 'running');
      }
      state.status = 'running';
      break;
    }
    case 'verification.completed': {
      // 验证结果一律记录（它确实发生了），状态是否可迁移另判
      state.lastVerification = { verifierId: event.verifierId, passed: event.passed, ts: event.ts };
      const to: MissionStatus = event.passed ? 'completed' : 'failed';
      // 这里用 canTransition 而不是 assertStatusChange：后者一律拒绝置 completed
      // （那是给 status_changed 用的）。completed 的**唯一**入口就是本分支——
      // 即「必须有一次通过的验证」，而不是某个调用方声明自己完成了。
      if (!canTransition(state.status, to)) {
        throw new MissionTransitionError(state.status, to);
      }
      state.status = to;
      break;
    }
  }
}

/**
 * 顺序重放事件，返回重建态。纯函数：不写盘、不发通知、不调度。
 *
 * 与 applyMissionEvent 的差异：非法迁移**跳过并计数**，不抛错——
 * 读日志必须容错，但跳过要可见（见 MissionAttemptState.skippedTransitions）。
 */
export function replayMissionEvents(
  events: readonly MissionEvent[],
  base?: MissionAttemptState,
): MissionAttemptState {
  const state = base ?? emptyMissionState();
  for (const event of events) {
    try {
      applyMissionEvent(state, event);
    } catch (e) {
      if (e instanceof MissionTransitionError) {
        state.skippedTransitions += 1;
        continue;
      }
      throw e;
    }
  }
  return state;
}

/**
 * 检测事件序号缺口：返回缺失的 seq 列表（最多列出 limit 个）。
 * 只追加的日志理论上不应有缺口；有缺口说明被外部截断或改写，需要显式暴露。
 */
export function findSeqGaps(events: readonly MissionEvent[], limit = 10): number[] {
  const gaps: number[] = [];
  let expected = 1;
  for (const e of events) {
    while (expected < e.seq) {
      if (gaps.length >= limit) return gaps;
      gaps.push(expected);
      expected += 1;
    }
    expected = e.seq + 1;
  }
  return gaps;
}
