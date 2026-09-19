/**
 * Mission 领域类型（P0-A）。
 *
 * 定位：Mission 是「带接受标准、可恢复、可证明完成」的工程任务容器，
 * 与 Session（对话载体）正交。Session 保存消息；Mission 保存任务身份、
 * 接受标准、状态迁移与证据引用。
 *
 * 本文件只放类型与常量，不含 IO、不含状态迁移逻辑（迁移见 state.ts）。
 */

/** Mission 事件信封的格式版本。首条事件携带，供将来演进判别。 */
export const MISSION_FORMAT_VERSION = 1;

/** Mission manifest 的格式版本。 */
export const MISSION_MANIFEST_VERSION = 1;

/**
 * Mission 生命周期状态。
 *
 * 终态是 completed 与 stopped：
 * - completed 只能由 verification.completed(passed=true) 触发，status_changed 不允许直接置位
 *   （这是「模型自报成功不算完成」在类型与迁移层面的落点）。
 * - stopped 表示用户要求停止且底层执行已确认收尾；终态不可自动复活。
 * - failed / blocked 不是终态：事实链完整，允许再次 resume。
 */
export type MissionStatus =
  | 'planned'
  | 'running'
  | 'paused'
  | 'recovering'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'stopped';

/** 机器可判定的接受标准：一条命令 + 期望退出码。 */
export interface MissionAcceptance {
  /** 待执行的校验命令（由调用方在受控环境下执行，不由模型自报）。 */
  command: string;
  /** 期望的进程退出码。 */
  expectExit: number;
  /** 人类可读的说明，便于在 status / proof 中展示。 */
  description?: string;
}

/** 任务级策略（预算与权限），P0-A 只做记录，不在此层强制执行。 */
export interface MissionPolicy {
  maxAttempts?: number;
  maxTurns?: number;
  /** 权限模式名（manual / auto / yolo），记录创建时的意图。 */
  permission?: string;
}

/**
 * 任务级范围约束（可选，验收的一部分）。
 *
 * 声明后 `verify` 会把它当独立检查项：自范围基线（第一个检查点的 HEAD）以来的
 * 全部变更文件（含提交与未提交）必须至少匹配一个 glob，越界即验收不通过。
 * 这是「只改这两个文件」从口头约定变成机器判定——小模型多文件重构里
 * 「顺手改了第三个文件」的典型失败形态由此有了兜底。
 */
export interface MissionScope {
  /** 允许变更的文件 glob 清单（`*` 不跨目录段、`**` 跨、`?` 单字符；语义见 verify.fileMatchesGlob）。 */
  allowFiles: string[];
}

/** Mission manifest：任务的稳定身份与接受标准。 */
export interface MissionManifest {
  manifestVersion: number;
  missionId: string;
  /** 任务所属仓库绝对路径（Mission 按仓库分桶）。 */
  repo: string;
  objective: string;
  acceptance: MissionAcceptance[];
  policy: MissionPolicy;
  /** 任务级范围约束；未声明时 verify 不做范围检查。 */
  scope?: MissionScope;
  createdAt: string;
  /**
   * 关联的会话 id（可选）。
   *
   * 存在的意义：进程死在工具调用中途时，悬空 tool_use 记录在**会话**里而不在
   * Mission 事件里。resume 想回答「上次是不是断在工具中途」，就必须能找回那个会话。
   * 缺省时 resume 只是少一路信号，不报错。
   */
  sessionId?: string;
}

/**
 * Mission 事件信封的公共字段。
 *
 * 与 wire.jsonl 的关系：wire 是**会话**事实源；Mission 事件是**任务**事实源，
 * 单独落盘（<missionId>.events.jsonl），不写进会话 wire，避免两个生命周期互相污染。
 * 两者共享同一条纪律：只追加、永不重写、重放必须无副作用。
 */
export interface MissionEventBase {
  eventId: string;
  /** 单调递增序号（从 1 开始），用于检测缺口。 */
  seq: number;
  ts: string;
  missionId: string;
  /** 执行尝试标识。P0-A 只有 attempt-1；P1 支持换模型重试后递增。 */
  attemptId: string;
}

/** Mission 事件判别联合。 */
export type MissionEvent =
  | (MissionEventBase & {
      type: 'mission.created';
      repo: string;
      objective: string;
      acceptanceCount: number;
    })
  | (MissionEventBase & {
      type: 'mission.status_changed';
      from: MissionStatus;
      to: MissionStatus;
      reason?: string;
    })
  | (MissionEventBase & {
      type: 'checkpoint.created';
      checkpointId: string;
      label: string;
      /**
       * 建立检查点时的 HEAD sha。resume 用它回答「检查点之后仓库动了没有」。
       * 非 git 仓 / 空仓时缺省——此时漂移不可判定，resume 会如实标注。
       */
      gitHead?: string;
      /** 相对上一个检查点，提交层面的变更文件。 */
      changedFiles?: string[];
      /** 建检查点那一刻工作区是否不干净。脏检查点不能当干净基线。 */
      dirty?: boolean;
    })
  | (MissionEventBase & {
      type: 'recovery.started';
      fromCheckpointId?: string;
      reason: string;
    })
  | (MissionEventBase & {
      type: 'recovery.completed';
      /** 本次恢复重放的事件条数（不含本次新增）。 */
      replayedEvents: number;
    })
  | (MissionEventBase & {
      type: 'verification.completed';
      verifierId: string;
      passed: boolean;
      /**
       * 环境故障标记：true 时表示验证因执行环境坏了而无法得出结论
       * （如测试框架误删文件、模块解析失败、shell 缺失），**不是**断言未通过。
       * 此时状态机不置 completed/failed，而是退回 running，让调用方/人工决定下一步。
       * 关键不变量：harness failure ≠ 模型/断言失败，两者在读数上必须可区分（对齐 benchmark 的 D1 教训）。
       */
      harnessError?: boolean;
      /** 证据包文件名（落在 Mission 目录下的 `.evidence/` 子目录），供 `status` 与 `prove` 引用。 */
      evidenceRef?: string;
    });

/** 事件类型名联合，供 CLI / 测试按类型过滤。 */
export type MissionEventType = MissionEvent['type'];

/** 单次 attempt 的派生状态（由事件重放得到，不落盘、不手改）。 */
export interface MissionAttemptState {
  status: MissionStatus;
  /** 最近一次 checkpoint 的 id；从未创建则为 undefined。 */
  lastCheckpointId?: string;
  /** 已产生的 checkpoint 数量。 */
  checkpointCount: number;
  /** 已发生的恢复次数（recovery.started 计数）。 */
  recoveryCount: number;
  /** 最近一次 verification 的结果；未验证过则为 undefined。 */
  lastVerification?: { verifierId: string; passed: boolean; ts: string; harnessError?: boolean };
  /** 最近一次状态变更原因。 */
  lastReason?: string;
  /** 已重放的事件总数（含本次）。 */
  eventCount: number;
  /**
   * 重放时被跳过的非法状态迁移数量。
   *
   * 为什么不是直接抛错：读日志必须能容错——损坏或被外部改写的日志不应该让
   * `mission status` 直接炸掉。但跳过必须**可见**：这个计数会出现在 status 输出里，
   * 让「有东西不对」显式暴露，而不是静默吞掉。
   */
  skippedTransitions: number;
}

/** 完整派生状态：manifest + attempt 状态 + 事件序列。 */
export interface MissionView {
  manifest: MissionManifest;
  state: MissionAttemptState;
  events: MissionEvent[];
}
