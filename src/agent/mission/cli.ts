/**
 * Mission 无头子命令：list / show / status / replay / create / checkpoint / resume。
 *
 * 设计纪律（对齐 config export / doctor config 的既有形态）：
 * - 不进 TUI、不加载 provider、不烧 token；纯本地读写。
 * - `replay` 与 `resume`（不带 --confirm）是只读的：不写事件、不调度、不发通知。
 * - 退出码 0/非 0，供 CI 与脚本断言。
 *
 * 尚未实现（属于后续阶段，不要在这里假装有）：verify / prove（P0-C）。
 * `resume --confirm` 只重建事实链并记录恢复事件，**不启动 agent**——接线到
 * PiChat 组合根属后续工作。
 */
import { resolve } from 'node:path';
import { SessionStore } from '../../session/store.js';
import { isTerminal, MissionTransitionError } from './state.js';
import { findSeqGaps } from './state.js';
import { probeGit } from './git.js';
import { buildRecoveryPlan, createSessionProbe, lastCheckpointOf, type RecoveryPlan } from './resume.js';
import { MissionStore } from './store.js';
import type { MissionAcceptance, MissionEvent, MissionPolicy, MissionStatus } from './types.js';

export interface MissionCommandResult {
  stdout?: string;
  stderr?: string;
  code: number;
}

const USAGE = [
  'usage: step mission <subcommand>',
  '',
  '  list                              列出当前目录的 Mission',
  '  show <mission-id>                 查看 manifest',
  '  status <mission-id>               查看派生状态（含日志健康告警）',
  '  replay <mission-id>               按序打印事件（只读，不执行副作用）',
  '  create --objective <文本> [选项]   创建 Mission',
  '  start <mission-id> [--reason <文本>]     开始执行（planned/paused/failed/blocked → running）',
  '  pause <mission-id> [--reason <文本>]     暂停（running → paused）',
  '  stop <mission-id> [--reason <文本>]      停止（终态，不可复活）',
  '  checkpoint <mission-id> --label <文本>   记录一个恢复检查点（含 git HEAD）',
  '  resume <mission-id> [--confirm]   恢复分析（只读）；--confirm 记录恢复并回到 running',
  '',
  'create 选项：',
  '  --acceptance <命令>[:<期望退出码>]  可重复；缺省退出码 0',
  '  --max-turns <n>                   记录轮次预算（P0-A 仅登记，不强制）',
  '  --max-attempts <n>                记录尝试预算（P0-A 仅登记，不强制）',
  '  --permission <manual|auto|yolo>   记录创建时的权限意图',
  '  --session <会话 id>               关联会话，让 resume 能发现悬空工具调用',
  '  --repo <路径>                     任务所属仓库，缺省当前目录',
  '',
  'checkpoint 选项：',
  '  --label <文本>                    必填，说明这个恢复点意味着什么',
  '  --allow-dirty                     允许在工作区不干净时建检查点（默认拒绝）',
  '',
  '尚未实现：verify / prove（属 P0-C）。',
].join('\n');

/**
 * 入口：按子命令分派。`args` 是 `mission` 之后的位置参数（不含 `mission` 本身）。
 *
 * `store` 可注入：测试必须能指向临时目录，否则会往真实 `~/.step-pilot/missions` 写数据。
 */
export async function runMissionCommand(
  args: string[],
  cwd: string,
  store: MissionStore = new MissionStore(),
): Promise<MissionCommandResult> {
  const sub = args[0];
  if (sub === undefined || sub === 'help' || sub === '--help') {
    return { stdout: `${USAGE}\n`, code: 0 };
  }
  switch (sub) {
    case 'list':
      return cmdList(store, cwd);
    case 'show':
      return cmdShow(store, cwd, args[1]);
    case 'status':
      return cmdStatus(store, cwd, args[1]);
    case 'replay':
      return cmdReplay(store, cwd, args[1]);
    case 'create':
      return cmdCreate(store, cwd, args.slice(1));
    case 'start':
      return cmdTransition(store, cwd, args.slice(1), 'running', 'start');
    case 'pause':
      return cmdTransition(store, cwd, args.slice(1), 'paused', 'pause');
    case 'stop':
      return cmdTransition(store, cwd, args.slice(1), 'stopped', 'stop');
    case 'checkpoint':
      return await cmdCheckpoint(store, cwd, args.slice(1));
    case 'resume':
      return await cmdResume(store, cwd, args.slice(1));
    case 'verify':
    case 'prove':
      return {
        stderr: `mission ${sub} 尚未实现（属后续阶段：verify/prove=P0-C）。当前可用：list / show / status / replay / create / start / pause / stop / checkpoint / resume。\n`,
        code: 2,
      };
    default:
      return { stderr: `未知 mission 子命令：${sub}\n${USAGE}\n`, code: 1 };
  }
}

function cmdList(store: MissionStore, cwd: string): MissionCommandResult {
  const missions = store.list(cwd);
  if (missions.length === 0) {
    return { stdout: '（当前目录没有 Mission。用 `step mission create --objective "..."` 创建。）\n', code: 0 };
  }
  const lines = missions.map((m) => {
    const view = store.load(cwd, m.missionId);
    const status = view?.state.status ?? 'planned';
    return `${m.missionId}  ${status.padEnd(10)}  ${m.createdAt}  ${m.objective}`;
  });
  return { stdout: `${lines.join('\n')}\n`, code: 0 };
}

function cmdShow(store: MissionStore, cwd: string, id: string | undefined): MissionCommandResult {
  if (id === undefined) return { stderr: 'usage: step mission show <mission-id>\n', code: 1 };
  const manifest = store.loadManifest(cwd, id);
  if (manifest === null) return { stderr: `找不到 Mission：${id}\n`, code: 1 };
  const lines = [
    `mission:     ${manifest.missionId}`,
    `repo:        ${manifest.repo}`,
    `objective:   ${manifest.objective}`,
    `created:     ${manifest.createdAt}`,
    `manifestVer: ${manifest.manifestVersion}`,
    'acceptance:',
  ];
  if (manifest.acceptance.length === 0) {
    lines.push('  （无——缺少机器可判定标准时不应据此宣称完成）');
  } else {
    for (const a of manifest.acceptance) {
      lines.push(`  - ${a.command}  (expect exit ${a.expectExit})${a.description !== undefined ? `  # ${a.description}` : ''}`);
    }
  }
  const policy = formatPolicy(manifest.policy);
  if (policy !== undefined) lines.push(`policy:      ${policy}`);
  return { stdout: `${lines.join('\n')}\n`, code: 0 };
}

function cmdStatus(store: MissionStore, cwd: string, id: string | undefined): MissionCommandResult {
  if (id === undefined) return { stderr: 'usage: step mission status <mission-id>\n', code: 1 };
  const view = store.load(cwd, id);
  if (view === null) return { stderr: `找不到 Mission：${id}\n`, code: 1 };
  const { manifest, state, events, health } = view;
  const lines = [
    `mission:      ${manifest.missionId}`,
    `status:       ${state.status}`,
    `objective:    ${manifest.objective}`,
    `checkpoints:  ${state.checkpointCount}${state.lastCheckpointId !== undefined ? `（最近 ${state.lastCheckpointId}）` : ''}`,
    `recoveries:   ${state.recoveryCount}`,
    `events:       ${state.eventCount}`,
    `verification: ${formatVerification(state.lastVerification)}`,
  ];
  if (state.lastReason !== undefined) lines.push(`lastReason:   ${state.lastReason}`);

  // 日志健康告警：读日志容错，但「有东西不对」必须显式暴露而不是静默吞掉
  const warnings: string[] = [];
  if (health.corruptLines > 0) {
    warnings.push(`事件日志有 ${health.corruptLines} 行无法解析（已跳过）——事实链可能被截断或外部改写。`);
  }
  if (state.skippedTransitions > 0) {
    warnings.push(`重放时有 ${state.skippedTransitions} 次非法状态迁移被跳过——日志与状态机不一致。`);
  }
  const gaps = findSeqGaps(events);
  if (gaps.length > 0) {
    warnings.push(`事件序号存在缺口：${gaps.join(', ')}——日志可能不完整。`);
  }
  if (state.status === 'completed' && state.lastVerification?.passed !== true) {
    warnings.push('状态为 completed 但缺少通过的验证记录——不应采信该完成态。');
  }
  if (manifest.acceptance.length === 0 && state.status === 'completed') {
    warnings.push('completed 但 manifest 没有接受标准——完成无机器依据。');
  }
  for (const w of warnings) lines.push(`warning:      ${w}`);
  return { stdout: `${lines.join('\n')}\n`, code: 0 };
}

function cmdReplay(store: MissionStore, cwd: string, id: string | undefined): MissionCommandResult {
  if (id === undefined) return { stderr: 'usage: step mission replay <mission-id>\n', code: 1 };
  const view = store.load(cwd, id);
  if (view === null) return { stderr: `找不到 Mission：${id}\n`, code: 1 };
  if (view.events.length === 0) {
    return { stdout: `（${id} 没有事件。事实源为空，不能据此判断任务进度。）\n`, code: 0 };
  }
  const lines = view.events.map((e) => `#${String(e.seq).padStart(3, ' ')}  ${e.ts}  ${formatEvent(e)}`);
  const header = `（只读重放：${view.events.length} 条事件；不执行副作用、不发送通知、不写盘。）`;
  return { stdout: `${header}\n${lines.join('\n')}\n`, code: 0 };
}

function cmdCreate(store: MissionStore, cwd: string, args: string[]): MissionCommandResult {
  const parsed = parseCreateArgs(args);
  if (parsed.error !== undefined) return { stderr: `${parsed.error}\n`, code: 1 };
  const repo = parsed.repo !== undefined ? resolve(parsed.repo) : cwd;
  if (parsed.objective === undefined || parsed.objective.trim() === '') {
    return { stderr: 'create 需要 --objective <文本>（任务目标不能为空）。\n', code: 1 };
  }
  const manifest = store.create({
    repo,
    objective: parsed.objective.trim(),
    acceptance: parsed.acceptance,
    policy: parsed.policy,
    ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
  });
  const note =
    parsed.acceptance.length === 0
      ? '注意：未提供接受标准——没有机器可判定依据时，不应把该 Mission 判为完成。\n'
      : '';
  return {
    stdout: `已创建 Mission：${manifest.missionId}\nrepo: ${manifest.repo}\n${note}用 \`step mission status ${manifest.missionId}\` 查看状态。\n`,
    code: 0,
  };
}

/**
 * 通用状态迁移命令（start / pause / stop）。
 *
 * 校验在 store 侧（写入前用状态机校验），这里只把 MissionTransitionError 翻成可读文案——
 * 非法迁移**不会**被写进事实源，所以用户看到的是「拒绝了」，而不是「写进去了但读不出来」。
 */
function cmdTransition(
  store: MissionStore,
  cwd: string,
  args: string[],
  to: MissionStatus,
  verb: string,
): MissionCommandResult {
  const id = args[0];
  if (id === undefined || id.startsWith('--')) {
    return { stderr: `usage: step mission ${verb} <mission-id> [--reason <文本>]\n`, code: 1 };
  }
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : undefined;
  const view = store.load(cwd, id);
  if (view === null) return { stderr: `找不到 Mission：${id}\n`, code: 1 };
  const from = view.state.status;
  // 空操作不写盘：状态机为了**重放容错**允许同状态迁移（from === to 返回 true），
  // 但命令层不该把「什么也没发生」写成一条事件——那只是往事实源里灌噪音。
  if (from === to) {
    return { stderr: `当前状态已经是 ${to}，无需迁移（未写入事实源）。\n`, code: 1 };
  }
  try {
    store.appendEvent(view.manifest.repo, id, {
      type: 'mission.status_changed',
      from,
      to,
      ...(reason !== undefined ? { reason } : {}),
    });
  } catch (e) {
    if (e instanceof MissionTransitionError) {
      return { stderr: `当前状态 ${from} 不能迁移到 ${to}（拒绝写入事实源）。\n`, code: 1 };
    }
    throw e;
  }
  return { stdout: `${id}: ${from} → ${to}\n`, code: 0 };
}

/**
 * 记录一个检查点。
 *
 * 两个刻意的拒绝（都不是为了严格而严格）：
 * - 终态 / 未开始的 Mission 不接受检查点：没有可恢复的东西，记录了只会误导。
 * - 工作区不干净时默认拒绝，必须显式 `--allow-dirty`：脏检查点不能当干净基线，
 *   而「默认允许」会让 resume 端把不干净误读成干净。让调用方显式承担这个判断。
 */
async function cmdCheckpoint(store: MissionStore, cwd: string, args: string[]): Promise<MissionCommandResult> {
  const id = args[0];
  if (id === undefined || id.startsWith('--')) {
    return { stderr: 'usage: step mission checkpoint <mission-id> --label <文本> [--allow-dirty]\n', code: 1 };
  }
  const labelIdx = args.indexOf('--label');
  const label = labelIdx >= 0 ? args[labelIdx + 1] : undefined;
  const allowDirty = args.includes('--allow-dirty');
  if (label === undefined || label.trim() === '') {
    return { stderr: 'checkpoint 需要 --label <文本>（说明这个恢复点意味着什么）。\n', code: 1 };
  }

  const view = store.load(cwd, id);
  if (view === null) return { stderr: `找不到 Mission：${id}\n`, code: 1 };
  if (isTerminal(view.state.status) || view.state.status === 'planned') {
    return {
      stderr: `当前状态 ${view.state.status} 不接受检查点（终态无物可恢复；planned 尚未开始）。\n`,
      code: 1,
    };
  }

  const prev = lastCheckpointOf(view.events);
  const git = await probeGit(view.manifest.repo, prev?.gitHead);

  if (!git.available) {
    return {
      stderr: `无法读取仓库状态：${git.note ?? '未知原因'}\nrepo: ${view.manifest.repo}\n`,
      code: 1,
    };
  }
  if (git.head === undefined) {
    return {
      stderr: `仓库还没有任何提交（无 HEAD），无法建立可对齐的检查点。\nrepo: ${view.manifest.repo}\n`,
      code: 1,
    };
  }
  if (git.dirty === true && !allowDirty) {
    const files = git.uncommittedChanges ?? [];
    return {
      stderr:
        `工作区不干净（${files.length} 个文件未提交），拒绝建立检查点。\n` +
        `  ${files.slice(0, 10).join('\n  ')}${files.length > 10 ? `\n  …还有 ${files.length - 10} 个` : ''}\n` +
        '先提交，或在确认「这个脏状态仍可作为恢复基线」时加 --allow-dirty。\n',
      code: 1,
    };
  }

  const checkpointId = nextCheckpointId(view.events);
  const event = store.appendEvent(view.manifest.repo, id, {
    type: 'checkpoint.created',
    checkpointId,
    label: label.trim(),
    gitHead: git.head,
    ...(git.committedChanges !== undefined && git.committedChanges.length > 0
      ? { changedFiles: git.committedChanges }
      : {}),
    ...(git.dirty === true ? { dirty: true } : {}),
  });

  const lines = [
    `已记录检查点 ${checkpointId}（seq ${event.seq}）`,
    `label:  ${label.trim()}`,
    `HEAD:   ${git.head.slice(0, 12)}`,
  ];
  if (git.committedChanges !== undefined && git.committedChanges.length > 0) {
    lines.push(`相对上一个检查点变更：${git.committedChanges.length} 个文件`);
  }
  if (git.dirty === true) {
    lines.push('warning: 检查点建立在脏工作区（--allow-dirty）——resume 会把它标为不可作干净基线。');
  }
  return { stdout: `${lines.join('\n')}\n`, code: 0 };
}

/**
 * 恢复分析。默认**只读**：不写事件、不调度、不发通知。
 * `--confirm` 才写 `recovery.started` + `recovery.completed`（状态回到 running）。
 */
async function cmdResume(store: MissionStore, cwd: string, args: string[]): Promise<MissionCommandResult> {
  const id = args[0];
  const confirm = args.includes('--confirm');
  if (id === undefined || id.startsWith('--')) {
    return { stderr: 'usage: step mission resume <mission-id> [--confirm]\n', code: 1 };
  }

  const view = store.load(cwd, id);
  if (view === null) return { stderr: `找不到 Mission：${id}\n`, code: 1 };

  const checkpoint = lastCheckpointOf(view.events);
  const git = await probeGit(view.manifest.repo, checkpoint?.gitHead);
  const sessionProbe = createSessionProbe(new SessionStore());
  const session =
    view.manifest.sessionId !== undefined ? sessionProbe.inspect(view.manifest.repo, view.manifest.sessionId) : undefined;

  const plan = buildRecoveryPlan({
    view,
    health: view.health,
    git,
    ...(session !== undefined ? { session } : {}),
  });

  const body = formatPlan(plan, confirm);
  if (!plan.resumable) {
    return { stderr: `${body}\n`, code: 1 };
  }
  if (!confirm) {
    return { stdout: `${body}\n`, code: 0 };
  }

  // --confirm：写入恢复事件。两处 append 都要先过状态机校验，
  // 因此非法情形（例如恢复中又被确认一次）会在写盘前抛错，而不是留下半条事实。
  store.appendEvent(view.manifest.repo, id, {
    type: 'recovery.started',
    ...(checkpoint !== undefined ? { fromCheckpointId: checkpoint.checkpointId } : {}),
    reason: 'mission resume --confirm',
  });
  const done = store.appendEvent(view.manifest.repo, id, {
    type: 'recovery.completed',
    replayedEvents: view.events.length,
  });
  const after = store.load(view.manifest.repo, id);
  return {
    stdout: `${body}\n已记录恢复：recovery.started + recovery.completed（seq ${done.seq}）\n新状态：${after?.state.status ?? '?'}\n注意：resume 不启动 agent，也不执行接受标准——它只重建事实链并记录恢复。\n`,
    code: 0,
  };
}

/** 下一个检查点 id：cp-001 起递增，取现有最大编号 + 1。 */
function nextCheckpointId(events: readonly MissionEvent[]): string {
  let max = 0;
  for (const e of events) {
    if (e.type !== 'checkpoint.created') continue;
    const m = /^cp-(\d+)$/.exec(e.checkpointId);
    if (m !== null) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return `cp-${String(max + 1).padStart(3, '0')}`;
}

/** 渲染恢复计划。 */
function formatPlan(plan: RecoveryPlan, confirm: boolean): string {
  const lines: string[] = [
    confirm ? '恢复分析（将写入恢复事件）' : '恢复分析（只读：不写事件、不调度、不发通知）',
    '',
    `mission:      ${plan.missionId}`,
    `objective:    ${plan.objective}`,
    `status:       ${plan.status}`,
    `可恢复:       ${plan.resumable ? '是' : '否'}`,
  ];
  if (!plan.resumable && plan.blockReason !== undefined) {
    lines.push(`阻塞原因:     ${plan.blockReason}`);
    return lines.join('\n');
  }

  if (plan.lastCheckpoint !== undefined) {
    const c = plan.lastCheckpoint;
    lines.push('', `最近检查点:    ${c.checkpointId}  ${c.ts}`, `              "${c.label}"`);
    lines.push(`检查点 HEAD:   ${c.gitHead !== undefined ? c.gitHead.slice(0, 12) : '（未记录）'}`);
  } else {
    lines.push('', '最近检查点:    （无）');
  }
  if (plan.git?.available === true) {
    lines.push(`当前 HEAD:     ${plan.git.head !== undefined ? plan.git.head.slice(0, 12) : '（空仓）'}`);
  }
  if (plan.drift !== undefined) {
    lines.push(`漂移:         ${describeDrift(plan.drift.kind)}${plan.drift.note !== undefined ? `（${plan.drift.note}）` : ''}`);
    for (const f of plan.drift.files.slice(0, 10)) lines.push(`  - ${f}`);
    if (plan.drift.files.length > 10) lines.push(`  …还有 ${plan.drift.files.length - 10} 个`);
  }
  if (plan.session !== undefined) {
    const s = plan.session;
    lines.push(
      '',
      s.exists
        ? `关联会话:      ${s.sessionId}（${s.messageCount} 条消息${s.danglingToolUseIds.length > 0 ? `，${s.danglingToolUseIds.length} 个悬空工具调用` : ''}）`
        : `关联会话:      ${s.sessionId}（在本仓库下找不到）`,
    );
  }

  if (plan.needsConfirmation.length > 0) {
    lines.push('', '需要确认:');
    plan.needsConfirmation.forEach((n, i) => lines.push(`  ${i + 1}. ${n}`));
  }
  if (plan.steps.length > 0) {
    lines.push('', '恢复计划:');
    plan.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  if (plan.warnings.length > 0) {
    lines.push('', '告警:');
    for (const w of plan.warnings) lines.push(`  - ${w}`);
  }
  if (!confirm) {
    lines.push('', '用 --confirm 记录恢复（recovery.started + recovery.completed → running）。');
  }
  return lines.join('\n');
}

function describeDrift(kind: 'none' | 'uncommitted' | 'committed' | 'unknown'): string {
  switch (kind) {
    case 'none':
      return '无（HEAD 与检查点一致，工作区干净）';
    case 'uncommitted':
      return '工作区有未提交改动';
    case 'committed':
      return '检查点之后有提交变更';
    case 'unknown':
      return '无法判定';
  }
}

interface ParsedCreate {
  objective?: string;
  repo?: string;
  sessionId?: string;
  acceptance: MissionAcceptance[];
  policy: MissionPolicy;
  error?: string;
}

/**
 * 解析 create 的位置参数。刻意手写而不是上 commander：
 * 这些是 `program.args` 里的位置参数（与 sessions/subagents 同一条既有路径），
 * 走 commander 子命令会与现有的 allowExcessArguments 机制打架。
 */
function parseCreateArgs(args: string[]): ParsedCreate {
  const out: ParsedCreate = { acceptance: [], policy: {} };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    switch (flag) {
      case '--objective':
        if (value === undefined) return { ...out, error: '--objective 缺少取值' };
        out.objective = value;
        i++;
        break;
      case '--repo':
        if (value === undefined) return { ...out, error: '--repo 缺少取值' };
        out.repo = value;
        i++;
        break;
      case '--session':
        if (value === undefined) return { ...out, error: '--session 缺少取值' };
        out.sessionId = value;
        i++;
        break;
      case '--acceptance': {
        if (value === undefined) return { ...out, error: '--acceptance 缺少取值' };
        out.acceptance.push(parseAcceptance(value));
        i++;
        break;
      }
      case '--max-turns': {
        const n = parsePositiveInt(value);
        if (n === undefined) return { ...out, error: '--max-turns 需要一个正整数' };
        out.policy.maxTurns = n;
        i++;
        break;
      }
      case '--max-attempts': {
        const n = parsePositiveInt(value);
        if (n === undefined) return { ...out, error: '--max-attempts 需要一个正整数' };
        out.policy.maxAttempts = n;
        i++;
        break;
      }
      case '--permission':
        if (value === undefined) return { ...out, error: '--permission 缺少取值' };
        out.policy.permission = value;
        i++;
        break;
      default:
        return { ...out, error: `未知选项：${flag}` };
    }
  }
  return out;
}

/**
 * 解析 `--acceptance`：`<命令>[:<期望退出码>]`。
 *
 * 只在**末尾**的 `:<数字>` 上切分——命令本身常含冒号（`bash -c "a:b"`、Windows 盘符），
 * 从第一个冒号切会把命令切坏。
 */
export function parseAcceptance(raw: string): MissionAcceptance {
  const m = /^(.*):(\d+)$/.exec(raw.trim());
  if (m === null || m[1] === undefined || m[1].trim() === '') {
    return { command: raw.trim(), expectExit: 0 };
  }
  return { command: m[1].trim(), expectExit: Number(m[2]) };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function formatPolicy(policy: MissionPolicy): string | undefined {
  const parts: string[] = [];
  if (policy.maxTurns !== undefined) parts.push(`maxTurns=${policy.maxTurns}`);
  if (policy.maxAttempts !== undefined) parts.push(`maxAttempts=${policy.maxAttempts}`);
  if (policy.permission !== undefined) parts.push(`permission=${policy.permission}`);
  return parts.length === 0 ? undefined : parts.join(' ');
}

function formatVerification(v: { verifierId: string; passed: boolean } | undefined): string {
  if (v === undefined) return 'pending（尚未验证——不得据此宣称完成）';
  return `${v.passed ? 'passed' : 'failed'}（${v.verifierId}）`;
}

function formatEvent(e: MissionEvent): string {
  switch (e.type) {
    case 'mission.created':
      return `mission.created  objective="${e.objective}" acceptance=${e.acceptanceCount}`;
    case 'mission.status_changed':
      return `status_changed    ${e.from} → ${e.to}${e.reason !== undefined ? `  reason="${e.reason}"` : ''}`;
    case 'checkpoint.created':
      return `checkpoint.created ${e.checkpointId}  "${e.label}"`;
    case 'recovery.started':
      return `recovery.started  reason="${e.reason}"${e.fromCheckpointId !== undefined ? `  from=${e.fromCheckpointId}` : ''}`;
    case 'recovery.completed':
      return `recovery.completed replayedEvents=${e.replayedEvents}`;
    case 'verification.completed':
      return `verification.completed ${e.verifierId}  ${e.passed ? 'passed' : 'failed'}`;
  }
}

/** 供 TUI / 其他调用方复用的状态文案（避免各处自己拼）。 */
export function describeStatus(status: MissionStatus): string {
  switch (status) {
    case 'planned':
      return '已创建，尚未开始执行';
    case 'running':
      return '执行中';
    case 'paused':
      return '已暂停（可 resume）';
    case 'recovering':
      return '正在从 checkpoint 恢复';
    case 'verifying':
      return '正在验证';
    case 'completed':
      return '已完成（验证通过）';
    case 'failed':
      return '失败（事实链完整，可 resume）';
    case 'blocked':
      return '阻塞（需要人工决策或外部条件）';
    case 'stopped':
      return '已停止（终态）';
  }
}
