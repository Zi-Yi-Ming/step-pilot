/**
 * Mission 恢复分析（P0-B）。
 *
 * 契约（重要，别改坏）：
 * - `buildRecoveryPlan()` 是**纯函数**：只读入参，不读盘、不写盘、不调度。
 * - 所有 IO 走注入的探测接口（GitProbe / SessionProbe），因此测试不需要真仓库。
 * - 分析结论里的每一项不确定性都进 `needsConfirmation`，绝不因为「大概率没事」
 *   就静默放行——恢复的诚实性正是这个模块的全部价值。
 *
 * 本模块**不启动 agent**：它回答「现在能不能继续、有哪些不确定」，把「怎么继续」
 * 留给调用方。这也是 `--confirm` 只写恢复事件、不偷偷跑工具的原因。
 */
import { findSeqGaps, canTransition } from './state.js';
import type { GitInspection } from './git.js';
import type { MissionEvent, MissionStatus, MissionView } from './types.js';

/** 会话侧探测结果。 */
export interface SessionInspection {
  sessionId: string;
  exists: boolean;
  messageCount: number;
  /** 末尾悬空的 tool_use id（进程死在工具中途的证据）。 */
  danglingToolUseIds: string[];
}

/** 会话探测接口（默认实现走 SessionStore；测试注入假实现）。 */
export interface SessionProbe {
  inspect(cwd: string, sessionId: string): SessionInspection;
}

/** 最近检查点的摘要。 */
export interface CheckpointInfo {
  checkpointId: string;
  label: string;
  ts: string;
  gitHead?: string;
  changedFiles?: string[];
  dirty?: boolean;
}

/** 漂移判定。`unknown` 是**一等结论**：不能判定时如实说不能判定。 */
export interface DriftReport {
  kind: 'none' | 'uncommitted' | 'committed' | 'unknown';
  files: string[];
  note?: string;
}

export interface RecoveryPlan {
  missionId: string;
  objective: string;
  status: MissionStatus;
  resumable: boolean;
  blockReason?: string;
  lastCheckpoint?: CheckpointInfo;
  git?: GitInspection;
  drift?: DriftReport;
  session?: SessionInspection;
  /** 需要人工确认的事项。为空才代表可以放心继续。 */
  needsConfirmation: string[];
  /** 人类可读的恢复计划步骤。 */
  steps: string[];
  warnings: string[];
}

/** 从事件序列里取最近一个 checkpoint。 */
export function lastCheckpointOf(events: readonly MissionEvent[]): CheckpointInfo | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'checkpoint.created') {
      const info: CheckpointInfo = { checkpointId: e.checkpointId, label: e.label, ts: e.ts };
      if (e.gitHead !== undefined) info.gitHead = e.gitHead;
      if (e.changedFiles !== undefined) info.changedFiles = e.changedFiles;
      if (e.dirty !== undefined) info.dirty = e.dirty;
      return info;
    }
  }
  return undefined;
}

export interface BuildPlanInput {
  view: MissionView;
  health: { corruptLines: number };
  /** git 探测结果；未探测时缺省。 */
  git?: GitInspection;
  /** 会话探测结果；manifest 未记录 sessionId 或缺省时无。 */
  session?: SessionInspection;
}

/**
 * 由已重建的视图 + 探测结果构造恢复计划。纯函数。
 */
export function buildRecoveryPlan(input: BuildPlanInput): RecoveryPlan {
  const { view, health, git, session } = input;
  const { manifest, state, events } = view;
  const plan: RecoveryPlan = {
    missionId: manifest.missionId,
    objective: manifest.objective,
    status: state.status,
    resumable: false,
    needsConfirmation: [],
    steps: [],
    warnings: [],
  };

  const checkpoint = lastCheckpointOf(events);
  if (checkpoint !== undefined) plan.lastCheckpoint = checkpoint;
  if (git !== undefined) plan.git = git;
  if (session !== undefined) plan.session = session;

  // ---- 可恢复性：直接复用状态机的迁移表，不另立一套判断 ----
  if (!canTransition(state.status, 'recovering')) {
    plan.resumable = false;
    plan.blockReason =
      state.status === 'planned'
        ? '任务尚未开始（planned）——先记录一个检查点，再谈恢复。'
        : `终态（${state.status}）不可恢复；要重做请新建 Mission。`;
    return plan;
  }
  plan.resumable = true;

  // ---- 漂移判定 ----
  plan.drift = judgeDrift(checkpoint, git);

  // ---- 需要确认的事项 ----
  if (checkpoint === undefined) {
    plan.needsConfirmation.push(
      '尚无检查点：恢复粒度是任务起点，无法回答「中断前做到哪一步」。',
    );
  }
  if (checkpoint?.dirty === true) {
    plan.needsConfirmation.push(
      `最近检查点 ${checkpoint.checkpointId} 是在**不干净的工作区**建立的，不能当作干净基线。`,
    );
  }
  if (plan.drift.kind === 'committed') {
    plan.needsConfirmation.push(
      `检查点之后有提交层面的变更（${plan.drift.files.length} 个文件）——确认它们属于本任务后再继续。`,
    );
  } else if (plan.drift.kind === 'uncommitted') {
    plan.needsConfirmation.push(
      `工作区有未提交改动（${plan.drift.files.length} 个文件）——恢复前确认这些改动的归属。`,
    );
  } else if (plan.drift.kind === 'unknown' && plan.drift.note !== undefined) {
    plan.needsConfirmation.push(`无法判定仓库漂移：${plan.drift.note}`);
  }
  if (session !== undefined && session.danglingToolUseIds.length > 0) {
    plan.needsConfirmation.push(
      `关联会话 ${session.sessionId} 末尾有 ${session.danglingToolUseIds.length} 个未闭合的工具调用` +
        '——进程很可能死在工具执行中途，恢复时会合成 is_error 结果（不假装成功）。',
    );
  }
  if (manifest.sessionId !== undefined && session?.exists === false) {
    plan.needsConfirmation.push(
      `manifest 记录了会话 ${manifest.sessionId}，但在本仓库下找不到它——悬空工具调用的信号不可用。`,
    );
  }
  if (manifest.acceptance.length > 0 && state.lastVerification === undefined) {
    plan.needsConfirmation.push(
      '接受标准尚未执行：verifier 属 P0-C，当前没有任何代码会跑它，因此本次恢复不能宣称任务完成。',
    );
  }

  // ---- 日志健康 ----
  if (health.corruptLines > 0) {
    plan.warnings.push(`事件日志有 ${health.corruptLines} 行无法解析（已跳过）——事实链可能被截断。`);
  }
  if (state.skippedTransitions > 0) {
    plan.warnings.push(`重放时有 ${state.skippedTransitions} 次非法状态迁移被跳过——日志与状态机不一致。`);
  }
  const gaps = findSeqGaps(events);
  if (gaps.length > 0) {
    plan.warnings.push(`事件序号存在缺口：${gaps.join(', ')}——日志可能不完整。`);
  }

  // ---- 恢复计划步骤 ----
  plan.steps.push('从最近检查点重建任务状态（事件重放，只读，不执行任何副作用）');
  if (session !== undefined && session.danglingToolUseIds.length > 0) {
    plan.steps.push(`闭合会话 ${session.sessionId} 末尾的悬空工具调用（合成 is_error 结果）`);
  }
  if (plan.drift.kind === 'committed' || plan.drift.kind === 'uncommitted') {
    plan.steps.push('确认检查点之后的改动归属（见「需要确认」）');
  }
  plan.steps.push('继续未完成的工作（当前版本不自动启动 agent——resume 只重建事实链并记录恢复）');
  if (manifest.acceptance.length > 0) {
    plan.steps.push('完成后运行接受标准（verifier 属 P0-C，尚未实现）');
  }

  return plan;
}

/** 漂移判定：把「能不能比较」和「比出来是什么」分开，避免把不可判定读成无漂移。 */
function judgeDrift(checkpoint: CheckpointInfo | undefined, git: GitInspection | undefined): DriftReport {
  if (checkpoint === undefined) {
    return { kind: 'unknown', files: [], note: '尚无检查点，没有可比对的基线。' };
  }
  if (checkpoint.gitHead === undefined) {
    return { kind: 'unknown', files: [], note: `检查点 ${checkpoint.checkpointId} 未记录 HEAD（非 git 仓或 git 不可用）。` };
  }
  if (git === undefined || !git.available) {
    return { kind: 'unknown', files: [], note: git?.note ?? 'git 探测未执行或不可用。' };
  }
  if (git.head === undefined) {
    return { kind: 'unknown', files: [], note: '当前仓库没有 HEAD（空仓）。' };
  }
  if (git.head !== checkpoint.gitHead) {
    const files = git.committedChanges ?? [];
    const note =
      files.length === 0
        ? `HEAD 已从 ${checkpoint.gitHead.slice(0, 8)} 变到 ${git.head.slice(0, 8)}，但列不出变更文件（可能是 rebase / 历史被改写）。`
        : undefined;
    return note === undefined ? { kind: 'committed', files } : { kind: 'committed', files, note };
  }
  if (git.dirty === true) {
    return { kind: 'uncommitted', files: git.uncommittedChanges ?? [] };
  }
  return { kind: 'none', files: [] };
}

/** 默认会话探测：走 SessionStore.resume（文档保证只读、无副作用，仅刷新内存缓存）。 */
export function createSessionProbe(store: {
  resume(cwd: string, id: string): { session: { messages: readonly unknown[] }; closedDanglingToolUse: boolean; closedToolUseIds: string[] } | null;
}): SessionProbe {
  return {
    inspect(cwd: string, sessionId: string): SessionInspection {
      const res = store.resume(cwd, sessionId);
      if (res === null) {
        return { sessionId, exists: false, messageCount: 0, danglingToolUseIds: [] };
      }
      return {
        sessionId,
        exists: true,
        messageCount: res.session.messages.length,
        // resume() 已经把悬空 tool_use 的闭合结果算好了，直接采信，不重复判定
        danglingToolUseIds: res.closedDanglingToolUse ? res.closedToolUseIds : [],
      };
    },
  };
}
