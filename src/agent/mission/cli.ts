/**
 * Mission 无头子命令（P0-A）：list / show / status / replay / create。
 *
 * 设计纪律（对齐 config export / doctor config 的既有形态）：
 * - 不进 TUI、不加载 provider、不烧 token；纯本地读写。
 * - 除 `create` 外全部只读；`replay` 只重放不执行任何副作用。
 * - 退出码 0/非 0，供 CI 与脚本断言。
 *
 * 尚未实现（属于后续阶段，不要在这里假装有）：resume / verify / prove。
 * resume 需要接 agent 编排与 checkpoint 对齐，属 P0-B；verifier 与 evidence 属 P0-C。
 */
import { resolve } from 'node:path';
import { findSeqGaps } from './state.js';
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
  '',
  'create 选项：',
  '  --acceptance <命令>[:<期望退出码>]  可重复；缺省退出码 0',
  '  --max-turns <n>                   记录轮次预算（P0-A 仅登记，不强制）',
  '  --max-attempts <n>                记录尝试预算（P0-A 仅登记，不强制）',
  '  --permission <manual|auto|yolo>   记录创建时的权限意图',
  '  --repo <路径>                     任务所属仓库，缺省当前目录',
  '',
  '尚未实现：resume / verify / prove（属 P0-B / P0-C）。',
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
    case 'resume':
    case 'verify':
    case 'prove':
      return {
        stderr: `mission ${sub} 尚未实现（属后续阶段：resume=P0-B，verify/prove=P0-C）。当前可用：list / show / status / replay / create。\n`,
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

interface ParsedCreate {
  objective?: string;
  repo?: string;
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
