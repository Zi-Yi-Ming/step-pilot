/**
 * Mission 无头子命令：list / show / status / replay / create / checkpoint / resume。
 *
 * 设计纪律（对齐 config export / doctor config 的既有形态）：
 * - 不进 TUI、不加载 provider、不烧 token；纯本地读写。
 * - `replay` 与 `resume`（不带 --confirm）是只读的：不写事件、不调度、不发通知。
 * - `verify` / `prove` 同样纯本地：跑 `acceptance` 命令、比退出码、写证据，不烧 token。
 * - 退出码 0/非 0，供 CI 与脚本断言。
 *
 * `resume --confirm` 只重建事实链并记录恢复事件，**不启动 agent**——接线到
 * PiChat 组合根属后续工作。P0-C（独立 verifier + evidence bundle）已落地。
 */
import { join, resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { SessionStore } from '../../session/store.js';
import { isTerminal, MissionTransitionError } from './state.js';
import { findSeqGaps } from './state.js';
import { probeGit } from './git.js';
import { buildRecoveryPlan, createSessionProbe, firstCheckpointOf, lastCheckpointOf, type RecoveryPlan } from './resume.js';
import { MissionStore } from './store.js';
import { defaultExecutor, judgeScope, mergeScopeIntoResult, runVerifier, type VerificationResult, type VerifyExecutor } from './verify.js';
import type { MissionAcceptance, MissionEvent, MissionPolicy, MissionStatus, MissionView } from './types.js';

export interface MissionCommandResult {
  stdout?: string;
  stderr?: string;
  code: number;
  /**
   * resume --run 桥接载荷：恢复事实链已记录后，交给组合根以非交互模式继续跑 agent。
   * 仅在 `resume --confirm --run` 且恢复分析判定可恢复时出现；其余命令恒为 undefined。
   * `sessionId` 是 manifest 关联的会话——组合根应优先恢复它，让 agent 看到中断前的上下文。
   */
  continueRun?: { prompt: string; sessionId?: string };
}

/** 运行选项：测试可注入 verify 的执行器，避免真跑 shell。 */
export interface MissionRunOptions {
  verifyExecutor?: VerifyExecutor;
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
  '  resume <mission-id> [--confirm] [--run]  恢复分析（只读）；--confirm 记录恢复；--run 记录后继续以非交互模式跑 agent',
  '  verify <mission-id> [--reason <文本>]     跑 acceptance 命令，独立判定完成（证据落盘）',
  '  prove <mission-id> [--out <目录>]         verify 并导出可检查的证据包（mission-proof/）',
  '',
  'create 选项：',
  '  --acceptance <命令>[:<期望退出码>]  可重复；缺省退出码 0',
  '  --allow-files <glob>              可重复；范围约束：verify 时自第一个检查点 HEAD 起，',
  '                                    全部变更文件须至少匹配一条（如 "src/**"），越界即不通过',
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
  'verify 选项：',
  '  --reason <文本>                   记录这次验证的来由（仅进证据，不改状态机）',
  '',
  'prove 选项：',
  '  --out <目录>                      证据包输出目录（缺省 ./mission-proof/<mission-id>/）',
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
  options: MissionRunOptions = {},
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
      return await cmdVerify(store, cwd, args.slice(1), options.verifyExecutor);
    case 'prove':
      return await cmdProve(store, cwd, args.slice(1), options.verifyExecutor);
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
  if (manifest.scope !== undefined) {
    lines.push('scope（范围约束，自第一个检查点 HEAD 起生效）:');
    for (const p of manifest.scope.allowFiles) lines.push(`  - ${p}`);
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
  if (state.lastVerification?.harnessError === true) {
    warnings.push('最近一次验证因环境故障而无法得出结论——该 Mission 的完成态不可采信，请修复环境后重跑 `step mission verify`。');
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
    ...(parsed.allowFiles.length > 0 ? { scope: { allowFiles: parsed.allowFiles } } : {}),
    ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
  });
  const notes: string[] = [];
  if (parsed.acceptance.length === 0) {
    notes.push('注意：未提供接受标准——没有机器可判定依据时，不应把该 Mission 判为完成。');
  }
  if (parsed.allowFiles.length > 0) {
    notes.push(
      `范围约束已生效（${parsed.allowFiles.length} 条 glob）：verify 时自第一个检查点的 HEAD 起检查全部变更文件，越界即验收不通过。`,
    );
  }
  const note = notes.length > 0 ? `${notes.join('\n')}\n` : '';
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
 * 由恢复分析合成续跑 prompt（纯函数，供 resume --run 桥接与测试使用）。
 *
 * 诚实性约束：只陈述恢复分析观察到的事实（目标、检查点、漂移、未决项、告警），
 * 不代模型宣称「已完成 X」；完成与否只由 `step mission verify` 独立判定——
 * 这条纪律与 verify 的「completed 只能由通过的验证触发」同源。
 * 指令部分用英文（对齐 system prompt 的模型侧语言），分析条目原样引用（数据，不是指令）。
 */
export function buildContinuationPrompt(plan: RecoveryPlan): string {
  const lines: string[] = [];
  lines.push('You are resuming an unfinished engineering task (Mission). A recovery analysis has been performed; continue the work from where it stopped.');
  lines.push('');
  lines.push('# Objective');
  lines.push(plan.objective);
  if (plan.lastCheckpoint !== undefined) {
    lines.push('');
    lines.push('# Last checkpoint');
    lines.push(`${plan.lastCheckpoint.label} (${plan.lastCheckpoint.checkpointId}, recorded at ${plan.lastCheckpoint.ts})`);
  }
  if (plan.drift !== undefined && plan.drift.kind !== 'none') {
    lines.push('');
    lines.push(`# Repository drift (${plan.drift.kind})`);
    if (plan.drift.files.length > 0) lines.push(`Files: ${plan.drift.files.join(', ')}`);
    if (plan.drift.note !== undefined) lines.push(plan.drift.note);
  }
  if (plan.needsConfirmation.length > 0) {
    lines.push('');
    lines.push('# Items needing attention (from the recovery analysis)');
    for (const item of plan.needsConfirmation) lines.push(`- ${item}`);
  }
  if (plan.warnings.length > 0) {
    lines.push('');
    lines.push('# Log health warnings');
    for (const w of plan.warnings) lines.push(`- ${w}`);
  }
  lines.push('');
  lines.push('# How to continue');
  lines.push('- Re-verify the items above against the actual repository before making changes; the analysis is a snapshot, not ground truth.');
  lines.push('- Continue the unfinished work; keep changes minimal.');
  lines.push('- Do NOT declare completion yourself: acceptance criteria are independently verified via `step mission verify`. Report honestly what is done and what remains.');
  return lines.join('\n');
}

/**
 * 恢复分析。默认**只读**：不写事件、不调度、不发通知。
 * `--confirm` 才写 `recovery.started` + `recovery.completed`（状态回到 running）。
 * `--run` 在 --confirm 之上再交给组合根以非交互模式续跑 agent（显式 opt-in：真实烧 token）。
 */
async function cmdResume(store: MissionStore, cwd: string, args: string[]): Promise<MissionCommandResult> {
  const id = args[0];
  const confirm = args.includes('--confirm');
  const run = args.includes('--run');
  if (id === undefined || id.startsWith('--')) {
    return { stderr: 'usage: step mission resume <mission-id> [--confirm] [--run]\n', code: 1 };
  }
  if (run && !confirm) {
    return {
      stderr:
        '--run 必须与 --confirm 一起使用：--run 会真实启动 agent 继续任务（消耗 token），不允许在只读分析里隐式发生。\n',
      code: 1,
    };
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
  const doneNote = `已记录恢复：recovery.started + recovery.completed（seq ${done.seq}）\n新状态：${after?.state.status ?? '?'}`;
  if (run) {
    // --run：把续跑交给组合根（cli.ts 落穿到 agent 引导）。这里只负责把事实链
    // 记完、把 prompt 合成好；绝不在此处直接启动 agent——那会绕过组合根的
    // provider/MCP/会话装配，也绕过 print 模式的全部既有纪律。
    return {
      stdout: `${body}\n${doneNote}\n已合成续跑 prompt，即将以非交互模式继续任务。完成判定仍以 \`step mission verify ${id}\` 为准——agent 跑完不代表 completed。\n`,
      code: 0,
      continueRun: {
        prompt: buildContinuationPrompt(plan),
        ...(view.manifest.sessionId !== undefined ? { sessionId: view.manifest.sessionId } : {}),
      },
    };
  }
  return {
    stdout: `${body}\n${doneNote}\n注意：resume 不启动 agent，也不执行接受标准——它只重建事实链并记录恢复。\n`,
    code: 0,
  };
}

/**
 * 验证前置检查：荷载、终态/planned、接受标准非空。
 * 与 resume 同纪律——只读地先把「能不能验证」说清楚，再谈副作用。
 */
function prepareVerify(
  store: MissionStore,
  cwd: string,
  id: string,
): { ok: true; view: MissionView } | { ok: false; error: { stderr: string; code: number } } {
  const view = store.load(cwd, id);
  if (view === null) return { ok: false, error: { stderr: `找不到 Mission：${id}\n`, code: 1 } };
  const status = view.state.status;
  if (status === 'completed') {
    return { ok: false, error: { stderr: `${id} 已通过验证（completed），无需重复验证。\n`, code: 1 } };
  }
  if (status === 'stopped') {
    return { ok: false, error: { stderr: `${id} 已停止（终态），不可验证。\n`, code: 1 } };
  }
  if (status === 'planned') {
    return {
      ok: false,
      error: { stderr: `${id} 尚未开始执行（planned），没有可验证的工作。先 \`step mission start ${id}\`。\n`, code: 1 },
    };
  }
  if (view.manifest.acceptance.length === 0) {
    return {
      ok: false,
      error: {
        stderr: `${id} 没有接受标准（acceptance 为空），独立 verifier 无命令可执行，不能据此宣称完成。请重建带 --acceptance 的 Mission。\n`,
        code: 1,
      },
    };
  }
  return { ok: true, view };
}

/** 把非 verifying 状态桥接到 verifying：running/recovering/verifying 直达；paused/failed/blocked 先进 running。 */
function bridgeToVerifying(store: MissionStore, repo: string, missionId: string, from: MissionStatus): void {
  if (from === 'verifying') return;
  if (from === 'running' || from === 'recovering') {
    store.appendEvent(repo, missionId, { type: 'mission.status_changed', from, to: 'verifying' });
    return;
  }
  // paused / failed / blocked：先桥接到 running（合法迁移），再进 verifying。两条事件都过状态机校验。
  store.appendEvent(repo, missionId, { type: 'mission.status_changed', from, to: 'running' });
  store.appendEvent(repo, missionId, { type: 'mission.status_changed', from: 'running', to: 'verifying' });
}

/**
 * 命令断言 + 可选范围断言的执行核心。
 *
 * 范围基线取**第一个检查点**的 HEAD（范围约束约束的是「本任务改了什么」，
 * 最近检查点会漏掉中间已提交的改动）。git 探测在此处发起；judgeScope 保持纯函数。
 */
async function runVerificationChecks(view: MissionView, executor: VerifyExecutor): Promise<VerificationResult> {
  let result = runVerifier(view.manifest.acceptance, { executor });
  const scope = view.manifest.scope;
  if (scope !== undefined) {
    const baseline = firstCheckpointOf(view.events)?.gitHead;
    const git = await probeGit(view.manifest.repo, baseline);
    result = mergeScopeIntoResult(
      result,
      judgeScope({
        scope,
        ...(baseline !== undefined ? { baselineHead: baseline } : {}),
        git,
      }),
    );
  }
  return result;
}

/** 构造可检查的证据对象（完整 stdout/stderr 进 evidence 文件；这里给结构化摘要）。 */
function buildEvidence(view: MissionView, result: VerificationResult, reason: string | undefined): unknown {
  return {
    missionId: view.manifest.missionId,
    objective: view.manifest.objective,
    repo: view.manifest.repo,
    verifierId: result.verifierId,
    allPassed: result.allPassed,
    harnessError: result.harnessError,
    reason: reason ?? null,
    generatedAt: new Date().toISOString(),
    checks: result.checks.map((c) => ({
      command: c.command,
      expectExit: c.expectExit,
      exitCode: c.exitCode,
      passed: c.passed,
      harnessError: c.harnessError,
      stdout: c.stdout,
      stderr: c.stderr,
    })),
    ...(result.scope !== undefined ? { scope: result.scope } : {}),
  };
}

/** 渲染验证结果摘要。 */
function formatVerify(result: VerificationResult, id: string, evidenceRef: string, seq: number): string {
  const label = result.allPassed ? '通过' : result.harnessError ? '环境故障（不可判定）' : '未通过';
  const lines = [
    `验证结果：${label}`,
    `verifier:    ${result.verifierId}`,
    `mission:     ${id}`,
    `evidence:    ${evidenceRef}（seq ${seq}）`,
    '',
    '检查项：',
  ];
  result.checks.forEach((c, i) => {
    const mark = c.passed ? '[PASS]' : '[FAIL]';
    lines.push(`  ${i + 1}. ${mark} exit=${c.exitCode ?? '?'} (expect ${c.expectExit})  ${c.command}`);
    if (!c.passed && c.harnessError !== null) lines.push(`        环境故障：${c.harnessError}`);
  });
  if (result.scope !== undefined) {
    const s = result.scope;
    if (s.kind === 'passed') {
      lines.push(`  scope: [PASS] ${s.changedCount} 个变更文件全部在允许范围内（基线 ${s.baselineHead?.slice(0, 8) ?? '?'}）`);
    } else if (s.kind === 'violated') {
      lines.push(
        `  scope: [FAIL] ${s.violations.length}/${s.changedCount} 个变更文件越界（基线 ${s.baselineHead?.slice(0, 8) ?? '?'}）：`,
      );
      for (const v of s.violations.slice(0, 20)) lines.push(`        - ${v}`);
      if (s.violations.length > 20) lines.push(`        …另有 ${s.violations.length - 20} 个越界文件（完整清单见证据文件）`);
    } else {
      lines.push(`  scope: [不可判定] ${s.note ?? '原因未记录'}`);
    }
  }
  if (result.harnessError) {
    lines.push(
      '',
      'WARN: 存在环境故障，验证未能得出结论。Mission 已退回 running，请勿据此宣称完成。修复环境后重跑 `step mission verify`。',
    );
  } else if (!result.allPassed) {
    lines.push('', '验证未通过：Mission 已置为 failed。修复后 start/resume 可再次推进，再 verify。');
  } else {
    lines.push('', '验证通过：Mission 已置为 completed（verification.completed(passed=true) 是唯一入口）。');
  }
  return lines.join('\n');
}

/** verify / prove 共用的执行核心：解析执行器 → 进入 verifying → 跑 verifier → 写证据 → 落 verification.completed。 */
type VerifyOutcome =
  | { kind: 'error'; stderr: string; code: number }
  | { kind: 'done'; result: VerificationResult; evidenceRef: string; code: number; summary: string };

async function runVerification(
  store: MissionStore,
  view: MissionView,
  reason: string | undefined,
  executorOverride?: VerifyExecutor,
): Promise<VerifyOutcome> {
  const { repo } = view.manifest;
  const id = view.manifest.missionId;

  // 先解析执行器：shell 缺失在此抛错，且必须在写任何事件之前——
  // 否则 Mission 会被卡在 verifying 而无法继续。
  let executor: VerifyExecutor;
  try {
    executor = executorOverride ?? defaultExecutor(repo);
  } catch (e) {
    return { kind: 'error', stderr: `${e instanceof Error ? e.message : String(e)}\n`, code: 1 };
  }

  // 进入 verifying（这条事件必须在跑命令之前落盘：若命令要跑很久，事实链上至少能看见「已进入 verifying」）
  try {
    bridgeToVerifying(store, repo, id, view.state.status);
  } catch (e) {
    if (e instanceof MissionTransitionError) {
      return { kind: 'error', stderr: `当前状态 ${view.state.status} 无法进入 verifying（拒绝写入事实源）。\n`, code: 1 };
    }
    throw e;
  }

  const result = await runVerificationChecks(view, executor);
  const evidence = buildEvidence(view, result, reason);
  const evidenceRef = store.writeEvidenceFile(repo, id, JSON.stringify(evidence, null, 2));

  let eventSeq = -1;
  try {
    const ev = store.appendEvent(repo, id, {
      type: 'verification.completed',
      verifierId: result.verifierId,
      passed: result.allPassed,
      ...(result.harnessError ? { harnessError: true } : {}),
      evidenceRef,
    });
    eventSeq = ev.seq;
  } catch (e) {
    if (e instanceof MissionTransitionError) {
      return { kind: 'error', stderr: `验证后状态迁移非法（拒绝写入事实源）：${e.message}\n`, code: 1 };
    }
    throw e;
  }

  return { kind: 'done', result, evidenceRef, code: result.allPassed ? 0 : 1, summary: formatVerify(result, id, evidenceRef, eventSeq) };
}

/**
 * 独立验证：跑 acceptance 命令、比对退出码、写证据、落 verification.completed。
 *
 * 退出码约定（供 CI 断言）：全部通过 → 0；任一未通过 → 1；环境故障（不可判定）→ 1。
 * 注意：环境故障同样返回 1，但它的语义是「没法验证」而非「没做对」——
 * Mission 会被退回 running 而非置 failed，status 也会显式标出 harness-error，
 * 调用方不应把它当成一次失败的工程工作。
 */
async function cmdVerify(
  store: MissionStore,
  cwd: string,
  args: string[],
  executorOverride?: VerifyExecutor,
): Promise<MissionCommandResult> {
  const id = args[0];
  if (id === undefined || id.startsWith('--')) {
    return { stderr: 'usage: step mission verify <mission-id> [--reason <文本>]\n', code: 1 };
  }
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : undefined;
  const pre = prepareVerify(store, cwd, id);
  if (!pre.ok) return { stderr: pre.error.stderr, code: pre.error.code };
  const outcome = await runVerification(store, pre.view, reason, executorOverride);
  if (outcome.kind === 'error') return { stderr: outcome.stderr, code: outcome.code };
  return { stdout: `${outcome.summary}\n`, code: outcome.code };
}

/** 导出可检查的证据包到目录（manifest + 时间线 + verifier 结果 + 完整证据）。 */
function writeProofBundle(outDir: string, view: MissionView, result: VerificationResult, evidenceRef: string, store: MissionStore): void {
  mkdirSync(outDir, { recursive: true });
  const evidencePath = join(store.evidenceDir(view.manifest.repo, view.manifest.missionId), evidenceRef);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(view.manifest, null, 2));
  writeFileSync(join(outDir, 'timeline.json'), JSON.stringify(view.events, null, 2));
  writeFileSync(join(outDir, 'verifier-results.json'), JSON.stringify(result.checks, null, 2));
  if (existsSync(evidencePath)) copyFileSync(evidencePath, join(outDir, 'evidence.json'));
  const readme = [
    `# Mission proof: ${view.manifest.missionId}`,
    '',
    `objective: ${view.manifest.objective}`,
    `verifier:  ${result.verifierId}`,
    `result:    ${result.allPassed ? 'PASS' : result.harnessError ? 'HARNESS ERROR (inconclusive)' : 'FAIL'}`,
    `generated: ${new Date().toISOString()}`,
    '',
    'Contents:',
    '- manifest.json          Mission 身份与接受标准',
    '- timeline.json          事件日志（事实源重放）',
    '- verifier-results.json  每条接受标准的退出码与判定',
    '- evidence.json          完整 stdout/stderr（命令输出）',
    '',
    '本证据包只能证明 verifier 覆盖的本地条件，不能证明远程生产系统或第三方副作用已回滚。',
  ].join('\n');
  writeFileSync(join(outDir, 'README.md'), readme);
}

/**
 * 验证并导出证据包。与 verify 同一条验证核心，额外把证据包写到目录。
 * 退出码语义与 verify 一致。
 */
async function cmdProve(
  store: MissionStore,
  cwd: string,
  args: string[],
  executorOverride?: VerifyExecutor,
): Promise<MissionCommandResult> {
  const id = args[0];
  if (id === undefined || id.startsWith('--')) {
    return { stderr: 'usage: step mission prove <mission-id> [--out <目录>]\n', code: 1 };
  }
  const outIdx = args.indexOf('--out');
  const outArg = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const pre = prepareVerify(store, cwd, id);
  if (!pre.ok) return { stderr: pre.error.stderr, code: pre.error.code };
  const outcome = await runVerification(store, pre.view, undefined, executorOverride);
  if (outcome.kind === 'error') return { stderr: outcome.stderr, code: outcome.code };
  const outDir = outArg !== undefined ? resolve(outArg) : join(cwd, 'mission-proof', id);
  // 重新载入视图：runVerification 已追加 verification.completed，pre.view 是验证前的快照，事件已过时。
  const freshView = store.load(cwd, id);
  if (freshView === null) return { stderr: `验证后找不到 Mission：${id}\n`, code: 1 };
  try {
    writeProofBundle(outDir, freshView, outcome.result, outcome.evidenceRef, store);
  } catch (e) {
    return { stderr: `证据包导出失败：${e instanceof Error ? e.message : String(e)}\n`, code: 1 };
  }
  return { stdout: `${outcome.summary}\n证据包已导出：${outDir}\n`, code: outcome.code };
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
    const effectNote =
      s.effects !== undefined
        ? `，${s.effects.length} 笔副作用（${s.effects.filter((e) => e.status === 'uncertain').length} 未闭环）`
        : '';
    lines.push(
      '',
      s.exists
        ? `关联会话:      ${s.sessionId}（${s.messageCount} 条消息${s.danglingToolUseIds.length > 0 ? `，${s.danglingToolUseIds.length} 个悬空工具调用` : ''}${effectNote}）`
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
  /** `--allow-files` 累积的 glob 清单；非空时成为 manifest.scope。 */
  allowFiles: string[];
  error?: string;
}

/**
 * 解析 create 的位置参数。刻意手写而不是上 commander：
 * 这些是 `program.args` 里的位置参数（与 sessions/subagents 同一条既有路径），
 * 走 commander 子命令会与现有的 allowExcessArguments 机制打架。
 */
function parseCreateArgs(args: string[]): ParsedCreate {
  const out: ParsedCreate = { acceptance: [], policy: {}, allowFiles: [] };
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
      case '--allow-files': {
        if (value === undefined) return { ...out, error: '--allow-files 缺少取值' };
        out.allowFiles.push(value);
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

function formatVerification(v: { verifierId: string; passed: boolean; harnessError?: boolean } | undefined): string {
  if (v === undefined) return 'pending（尚未验证——不得据此宣称完成）';
  const tag = v.passed ? 'passed' : 'failed';
  const h = v.harnessError === true ? '（环境故障，结论不可信赖）' : '';
  return `${tag}（${v.verifierId}）${h}`;
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
      return `verification.completed ${e.verifierId}  ${e.passed ? 'passed' : 'failed'}${e.harnessError === true ? '  [harness-error]' : ''}${e.evidenceRef !== undefined ? `  evidence=${e.evidenceRef}` : ''}`;
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
