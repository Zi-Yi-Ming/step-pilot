/**
 * P0-D：fault-injection benchmark + RCR（Recovery-Complete Rate）。
 *
 * 北极星指标：
 *   RCR = 在受控中断后，Mission 从持久化断点恢复、并最终通过独立 verifier 的比例。
 *
 * 为什么需要它：Mission 的整个论点是「模型可以失败，工程工作不能丢」。没有 RCR，
 * 这个论点只有机制、没有读数。本模块把「中断」变成可复现的输入，把「恢复」变成可数的输出。
 *
 * 两个刻意的设计选择：
 *
 * 1. **中断 = 事实链在某个点结束**。真实崩溃后能留下的就是事件日志的某个前缀，
 *    所以「杀掉进程」在本装置里等价于「把 `<missionId>.events.jsonl` 截断到第 N 条」。
 *    不需要真的杀进程，因此快、确定、可重复——而它检验的正是恢复逻辑真正依赖的东西。
 *
 * 2. **harness 故障与恢复失败分开计数**。verifier 因环境坏了而无法判定时，
 *    既不是「恢复成功」也不是「恢复失败」；它单独进 `harnessErrorRuns`。
 *    把两者混在一起，就会重演 benchmark 审计里 D1 的老毛病：框架 bug 被读成模型能力。
 *
 * 所有 Mission 生命周期都走真实实现（MissionStore + 状态机 + runMissionCommand），
 * 只有两个执行器被注入：verifier 的 shell 执行器、以及会话存储（避免污染真实 ~/.step-pilot）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMissionCommand } from '../src/agent/mission/cli.js';
import { MissionStore } from '../src/agent/mission/store.js';
import type { MissionStatus } from '../src/agent/mission/types.js';
import type { VerifyExecutor } from '../src/agent/mission/verify.js';
import { stored } from '../src/agent/message.js';
import { SessionStore } from '../src/session/store.js';

/** 故障注入场景。必须能区分「恢复路径」与「环境故障」。 */
export type FaultScenario =
  | 'clean' // 无中断 oracle：没有它，其余数字没有对照
  | 'kill-before-checkpoint' // 进程在建立检查点之前被杀：没有基线可用
  | 'kill-after-checkpoint' // 进程在检查点之后被杀：有基线可恢复
  | 'kill-during-tool' // 进程死在工具调用中途：留下悬空 tool_use
  | 'verifier-harness-error'; // 验证环境坏了：结论不可判定

export const ALL_SCENARIOS: readonly FaultScenario[] = [
  'clean',
  'kill-before-checkpoint',
  'kill-after-checkpoint',
  'kill-during-tool',
  'verifier-harness-error',
];

/** 合成 git HEAD：本装置检验恢复语义，不检验 git 锚定，故用固定 sha 而非真仓。 */
const SYNTHETIC_GIT_HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** 接受标准命令名（执行器注入，不真跑 shell）。 */
const ACCEPTANCE_CMD = 'acceptance-cmd';

/** 验证通过：退出码 0。 */
const passExecutor: VerifyExecutor = () => ({ exitCode: 0, stdout: 'ok', stderr: '' });

/** 环境故障：命令根本不存在——命中 isHarnessFailure 的 `command not found` 特征。 */
const harnessErrorExecutor: VerifyExecutor = () => ({
  exitCode: 127,
  stdout: '',
  stderr: `bash: ${ACCEPTANCE_CMD}: command not found`,
});

/** 单次故障注入 run 的结果。 */
export interface FaultRunResult {
  scenario: FaultScenario;
  missionId: string;
  /** 注入后是否还有可用的检查点基线。 */
  hadCheckpoint: boolean;
  /** 恢复分析判定为可恢复。 */
  resumable: boolean;
  /** `resume --confirm` 是否成功（退出码 0）。 */
  resumeOk: boolean;
  /** 验证结论。`not-run` 表示从未产生验证记录。 */
  verification: 'passed' | 'failed' | 'harness-error' | 'not-run';
  /** 终态。 */
  finalStatus: MissionStatus | 'unknown';
  /** 悬空工具调用闭合数（仅 kill-during-tool 非零）。 */
  danglingClosed: number;
  /** 中断后事件条数。 */
  events: number;
  /** 是否达成「中断后恢复，并最终通过独立 verifier」。RCR 的分子。 */
  recovered: boolean;
}

/** 场景聚合。 */
export interface ScenarioStat {
  runs: number;
  recovered: number;
  /** recovered / runs；runs === 0 时为 0。 */
  rcr: number;
}

/** RCR 报告。 */
export interface RcrReport {
  total: number;
  recovered: number;
  rcr: number;
  byScenario: Record<FaultScenario, ScenarioStat>;
  /** 因环境故障而不可判定的 run 数——**不计入** recovered，也不计入 failure。 */
  harnessErrorRuns: number;
  /** clean oracle 是否通过。false 意味着本批数字整体不可信（连无中断都过不了）。 */
  cleanOracleRecovered: boolean;
}

/** 从事件日志文本里找出 checkpoint.created 的行下标（0-based）。 */
function checkpointLineIndices(lines: readonly string[]): number[] {
  const idx: number[] = [];
  lines.forEach((l, i) => {
    if (l.includes('"checkpoint.created"')) idx.push(i);
  });
  return idx;
}

function readEventLines(store: MissionStore, repo: string, missionId: string): string[] {
  return readFileSync(store.eventsPath(repo, missionId), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

function writeEventLines(store: MissionStore, repo: string, missionId: string, lines: readonly string[]): void {
  writeFileSync(store.eventsPath(repo, missionId), `${lines.join('\n')}\n`, 'utf8');
}

/** 截断到「最后一个检查点之后」（含检查点本身）：模拟进程在检查点之后被杀。 */
function truncateAfterCheckpoint(store: MissionStore, repo: string, missionId: string): void {
  const lines = readEventLines(store, repo, missionId);
  const idx = checkpointLineIndices(lines);
  const last = idx.at(-1);
  if (last === undefined) return;
  writeEventLines(store, repo, missionId, lines.slice(0, last + 1));
}

/** 截断到「第一个检查点之前」（不含检查点）：模拟进程还没来得及建基线就被杀。 */
function truncateBeforeCheckpoint(store: MissionStore, repo: string, missionId: string): void {
  const lines = readEventLines(store, repo, missionId);
  const first = checkpointLineIndices(lines)[0];
  if (first === undefined) return;
  writeEventLines(store, repo, missionId, lines.slice(0, first));
}

/**
 * 造一个末尾带悬空 tool_use 的会话：模拟进程死在工具调用中途。
 *
 * 形状与真实崩溃一致——最后一条是 assistant 的 tool_use，后面没有配对的 tool_result，
 * 由 `SessionStore.resume()` 的 `closeDanglingToolUse` 检出。
 */
function craftDanglingSession(sessionStore: SessionStore, cwd: string, sessionId: string): void {
  const session = sessionStore.create(cwd, 'fault-injection');
  session.id = sessionId;
  // 游标必须显式置 0：resume() 在「快照没有 wireSeq」时会忽略快照 messages、从空基底
  // 全量重放事件（破坏性语义）。本会话没有 wire 事件，置 0 才让快照作为检查点生效、
  // 消息得以保留——否则悬空 tool_use 会被抹掉，场景变成空跑。
  session.wireSeq = 0;
  session.messages = [
    stored({ role: 'user', content: 'run the acceptance command' }, { kind: 'user' }),
    stored(
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_dangling_0001', name: 'bash', input: { command: ACCEPTANCE_CMD } }],
      },
      { kind: 'assistant' },
    ),
  ];
  sessionStore.save(session);
}

/** 运行选项。 */
export interface RunScenarioOptions {
  /** 任务所属仓库目录（隔离用；本装置不碰真实仓）。 */
  repo: string;
  store: MissionStore;
  sessionStore: SessionStore;
}

/**
 * 跑一个故障注入场景：create → start →（checkpoint）→ 注入故障 → resume --confirm → verify。
 *
 * 全程走真实 Mission 实现；只注入 verifier 执行器与会话存储。
 */
export async function runFaultScenario(scenario: FaultScenario, opts: RunScenarioOptions): Promise<FaultRunResult> {
  const { repo, store, sessionStore } = opts;
  const sessionId = `fault-session-${scenario}`;
  const useSession = scenario === 'kill-during-tool';

  const createArgs = ['create', '--objective', `fault-injection:${scenario}`, '--acceptance', ACCEPTANCE_CMD];
  if (useSession) createArgs.push('--session', sessionId);
  const created = await runMissionCommand(createArgs, repo, store);
  const missionId = /mission-[0-9a-z-]+/.exec(created.stdout ?? '')?.[0];
  if (missionId === undefined) {
    throw new Error(`create 未返回 mission id：${created.stdout ?? created.stderr ?? '(空)'}`);
  }
  await runMissionCommand(['start', missionId], repo, store);

  // 除 kill-before-checkpoint 外，都先建一个检查点（kill-before 会把它截掉）。
  store.appendEvent(repo, missionId, {
    type: 'checkpoint.created',
    checkpointId: 'cp-001',
    label: 'fault-injection baseline',
    gitHead: SYNTHETIC_GIT_HEAD,
  });

  // ---- 注入故障 ----
  if (scenario === 'kill-before-checkpoint') {
    truncateBeforeCheckpoint(store, repo, missionId);
  } else if (scenario === 'kill-after-checkpoint') {
    truncateAfterCheckpoint(store, repo, missionId);
  } else if (scenario === 'kill-during-tool') {
    truncateAfterCheckpoint(store, repo, missionId);
    craftDanglingSession(sessionStore, repo, sessionId);
  }

  const afterFault = store.load(repo, missionId);
  if (afterFault === null) throw new Error(`注入故障后找不到 Mission：${missionId}`);

  // ---- 恢复 ----
  // clean 是「无中断 oracle」：它不该走恢复路径，否则无从与中断场景对照。
  const isClean = scenario === 'clean';
  const resume = isClean
    ? { code: 0 }
    : await runMissionCommand(['resume', missionId, '--confirm'], repo, store, { sessionStore });

  // ---- 独立验证 ----
  const executor = scenario === 'verifier-harness-error' ? harnessErrorExecutor : passExecutor;
  await runMissionCommand(['verify', missionId], repo, store, { verifyExecutor: executor });

  const view = store.load(repo, missionId);
  if (view === null) throw new Error(`验证后找不到 Mission：${missionId}`);

  const lv = view.state.lastVerification;
  const verification: FaultRunResult['verification'] =
    lv === undefined ? 'not-run' : lv.harnessError === true ? 'harness-error' : lv.passed ? 'passed' : 'failed';

  return {
    scenario,
    missionId,
    hadCheckpoint: afterFault.state.lastCheckpointId !== undefined,
    resumable: resume.code === 0,
    resumeOk: resume.code === 0,
    verification,
    finalStatus: view.state.status,
    danglingClosed: countDangling(sessionStore, repo, sessionId, useSession),
    events: view.events.length,
    // RCR 分子：中断后恢复，且最终由独立 verifier 判定通过
    recovered: view.state.status === 'completed' && verification === 'passed',
  };
}

/** 读一次会话，取悬空闭合数；未使用会话的场景返回 0。 */
function countDangling(sessionStore: SessionStore, cwd: string, sessionId: string, used: boolean): number {
  if (!used) return 0;
  const res = sessionStore.resume(cwd, sessionId);
  return res?.closedDanglingToolUse === true ? res.closedToolUseIds.length : 0;
}

/** 纯函数聚合：由 run 结果算出 RCR 与分层指标。 */
export function computeRcr(results: readonly FaultRunResult[]): RcrReport {
  const byScenario = {} as Record<FaultScenario, ScenarioStat>;
  for (const s of ALL_SCENARIOS) byScenario[s] = { runs: 0, recovered: 0, rcr: 0 };

  let recovered = 0;
  let harnessErrorRuns = 0;
  for (const r of results) {
    const stat = byScenario[r.scenario];
    if (stat === undefined) continue;
    stat.runs += 1;
    if (r.recovered) {
      stat.recovered += 1;
      recovered += 1;
    }
    if (r.verification === 'harness-error') harnessErrorRuns += 1;
  }
  for (const s of ALL_SCENARIOS) {
    const stat = byScenario[s];
    stat.rcr = stat.runs === 0 ? 0 : stat.recovered / stat.runs;
  }

  const total = results.length;
  return {
    total,
    recovered,
    rcr: total === 0 ? 0 : recovered / total,
    byScenario,
    harnessErrorRuns,
    cleanOracleRecovered: results.some((r) => r.scenario === 'clean' && r.recovered),
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

/** 渲染 RCR 报告（Markdown）。 */
export function renderRcr(report: RcrReport): string {
  const lines = [
    '# RCR — Recovery-Complete Rate',
    '',
    '> 受控中断后，Mission 从持久化断点恢复、并最终通过独立 verifier 的比例。',
    '',
    `**RCR = ${pct(report.rcr)}**（${report.recovered}/${report.total}）`,
    '',
    '| 场景 | runs | recovered | RCR |',
    '|------|------|-----------|-----|',
  ];
  for (const s of ALL_SCENARIOS) {
    const stat = report.byScenario[s];
    if (stat.runs === 0) continue;
    lines.push(`| ${s} | ${stat.runs} | ${stat.recovered} | ${pct(stat.rcr)} |`);
  }
  lines.push(
    '',
    `- clean oracle 通过：${report.cleanOracleRecovered ? '是' : '否（本批数字整体不可信）'}`,
    `- 环境故障（不可判定，不计入 recovered）：${report.harnessErrorRuns}`,
    '',
    '> harness 故障与恢复失败分开计数：前者是「没法判定」，后者是「确实没恢复」。',
  );
  return lines.join('\n');
}

/** 跑完整套场景（每个场景一个隔离的临时目录）。 */
export async function runFaultBenchmark(): Promise<{ results: FaultRunResult[]; report: RcrReport }> {
  const results: FaultRunResult[] = [];
  for (const scenario of ALL_SCENARIOS) {
    const root = mkdtempSync(join(tmpdir(), 'fault-inj-'));
    try {
      const store = new MissionStore(join(root, 'missions'));
      const sessionStore = new SessionStore(join(root, 'sessions'));
      const repo = join(root, 'repo');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(repo, { recursive: true });
      results.push(await runFaultScenario(scenario, { repo, store, sessionStore }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return { results, report: computeRcr(results) };
}

/** CLI 入口。 */
async function main(): Promise<void> {
  const { results, report } = await runFaultBenchmark();
  console.log(renderRcr(report));
  console.log('');
  console.log('## 逐场景明细');
  console.log('');
  for (const r of results) {
    console.log(
      `- ${r.scenario}: status=${r.finalStatus} verification=${r.verification} ` +
        `hadCheckpoint=${r.hadCheckpoint} resumable=${r.resumable} ` +
        `danglingClosed=${r.danglingClosed} events=${r.events} recovered=${r.recovered}`,
    );
  }
}

const isDirect = process.argv[1] !== undefined && process.argv[1].endsWith('faultInjection.ts');
if (isDirect) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
