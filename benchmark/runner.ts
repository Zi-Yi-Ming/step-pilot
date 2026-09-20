import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task, Profile } from './types.js';
import { isHarnessFailure, type CheckOutcome } from './harnessFailure.js';
import { removeProfileConfig, writeProfileConfig } from './profileConfig.js';

/**
 * 纯函数：拼出 step-pilot 非交互运行的参数。
 *
 * 单独拆出来是为了可测——「profile 是否真的影响了命令行」这件事此前没有任何测试守着，
 * 于是它坏了也没人发现，ablation 跑出与 full 一模一样的结果还被当成结论。
 */
export function buildStepPilotArgs(opts: {
  repoDir: string;
  prompt: string;
  configPath?: string;
}): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--yolo', '-C', opts.repoDir];
  if (opts.configPath !== undefined) args.push('--config', opts.configPath);
  args.push(opts.prompt);
  return args;
}

export interface RunResult {
  task_id: string;
  category: string;
  profile: string;
  model: string;
  provider: string;
  step_pilot_commit: string;
  run_index: number;
  success: boolean;
  duration_ms: number;
  turns: number;
  tool_calls: number;
  tool_errors: number;
  retries: number;
  compactions: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  stop_reason: string | null;
  failure_reason: string | null;
  checks_passed: number;
  checks_failed: number;
  events: RawEvent[];
}

export interface RawEvent {
  type: string;
  [key: string]: unknown;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function getGitCommit(): string {
  try {
    const out = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' });
    if (out.status !== 0) throw new Error(out.stderr?.toString() ?? 'git failed');
    return (out.stdout?.toString() ?? '').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function runStepPilot(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: err?.status ?? null,
      });
    };

    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);

    // Windows cannot execute `.js` files directly via spawn without shell;
    // route them through `node` explicitly so we can capture stream-json output.
    const useShell = !cmd.endsWith('.js');
    const proc = useShell
      ? spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: true })
      : spawn('node', [cmd, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('error', finish);
    proc.on('close', finish);
  });
}

/**
 * Best-effort recursive directory removal on Windows.
 *
 * Some child processes spawned by step-pilot (git, node, shell) can keep
 * transient handles open inside the repo directory for a short window after
 * the main process exits. Instead of hard-failing, we retry a few times with
 * backoff so later runs are not polluted.
 */
async function removeRepoDir(repoDir: string): Promise<void> {
  const { existsSync, rmSync } = await import('node:fs');
  if (!existsSync(repoDir)) return;

  const maxAttempts = 4;
  const delays = [100, 300, 700, 1500];
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      rmSync(repoDir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, delays[attempt] ?? 1500));
      }
    }
  }

  // If all retries fail, do NOT throw. Two reasons:
  // 1. setup.sh already cleans the repo *contents* without removing the directory
  //    (its comment says "avoid Windows file locks"), so the removal here is
  //    belt-and-braces. Failing on it kills runs that would otherwise be fine.
  // 2. Throwing routes the run into the CLI catch block, which used to record it
  //    as a plain failure. That is how 10 runs of the easiest task showed up as
  //    0/10 while the real cause was a locked directory on Windows.
  // Warn loudly instead: the operator needs to know the workspace may be dirty.
  process.stderr.write(
    `[benchmark] warning: could not remove ${repoDir} after ${maxAttempts} attempts ` +
      `(${lastError?.message ?? 'unknown'}). Continuing; setup.sh cleans the contents.\n`,
  );
}

/**
 * run 抛错时的兜底结果。
 *
 * 走到这里意味着 agent 在启动前后就失败了（仓库清理 EBUSY、setup 失败…），
 * 模型根本没有机会干活。**必须标成 `harness_error`**，否则它会被当成
 * 「模型失败」计进成功率分母——那正是本项目明令分开的两件事。
 *
 * 实测踩过：Windows 上 `rmdir` EBUSY 让最简单的任务 10 个 run 全走这条路径，
 * 报告显示 0/10，而真正原因是环境锁目录。分母被悄悄污染，比没有数据更坏。
 *
 * 抽成导出函数是为了可测：这个分类一旦回归，只会以「某任务成功率莫名低」的形式出现。
 */
export function buildErrorResult(task: Task, profile: string, runIndex: number, err: unknown): RunResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    task_id: task.id,
    category: task.category,
    profile,
    model: 'step-3.7-flash',
    provider: 'stepfun',
    step_pilot_commit: getGitCommit(),
    run_index: runIndex,
    success: false,
    duration_ms: 0,
    turns: 0,
    tool_calls: 0,
    tool_errors: 0,
    retries: 0,
    compactions: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    stop_reason: null,
    failure_reason: message,
    checks_passed: 0,
    checks_failed: 0,
    harness_error: message,
    verification_skipped: true,
    events: [],
  };
}

export async function runTask(task: Task, profile: Profile, runIndex: number): Promise<RunResult> {
  const repoDir = join(__dirname, '..', task.repository);
  const startTime = Date.now();

  // Always start from a clean repo state for each run.
  if (existsSync(repoDir)) {
    await removeRepoDir(repoDir);
  }
  await executeSetup(task, repoDir);
  await linkParentDeps(repoDir);

  // Build step-pilot command
  const cmd = getStepPilotCommand();
  const prompt = (task as any).prompt ?? task.description ?? '';
  // profile 的 config 覆盖必须真正到达 agent：写一份临时 config.toml 并用 --config 传入。
  // 少了这一步，ablation 与 full 的行为完全一致，「关掉 harness 没差别」会是错误结论。
  const configPath = writeProfileConfig(profile);
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    const args = buildStepPilotArgs({ repoDir, prompt, configPath });
    const res = await runStepPilot(cmd, args, join(__dirname, '..'), (task.timeout ?? 120) * 1000);
    stdout = res.stdout;
    stderr = res.stderr;
    exitCode = res.exitCode;
  } finally {
    removeProfileConfig(configPath);
  }

  // Allow any lingering child-process handles to release on Windows before
  // verification/cleanup. This does not delay non-Windows platforms.
  if (process.platform === 'win32') {
    await new Promise((r) => setTimeout(r, 200));
  }

  const durationMs = Date.now() - startTime;

  const events: RawEvent[] = [];
  let toolCalls = 0;
  let toolErrors = 0;
  let retries = 0;
  let compactions = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let stopReason: string | null = null;
  let failureReason: string | null = null;
  let turns = 0;
  let resultSubtype: string | null = null;

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as RawEvent;
      events.push(ev);
      captureMetrics(ev, {
        toolCalls: (updater) => (toolCalls = updater(toolCalls)),
        toolErrors: (updater) => (toolErrors = updater(toolErrors)),
        retries: (updater) => (retries = updater(retries)),
        compactions: (updater) => (compactions = updater(compactions)),
        inputTokens: (updater) => (inputTokens = updater(inputTokens)),
        outputTokens: (updater) => (outputTokens = updater(outputTokens)),
        totalTokens: (updater) => (totalTokens = updater(totalTokens)),
        stopReason: (v) => (stopReason = v),
        failureReason: (v) => (failureReason = v),
        turns: (updater) => (turns = updater(turns)),
        resultSubtype: (v) => (resultSubtype = v),
      });
    } catch {
      // skip non-JSON lines
    }
  }

  // 判定口径（三条，全部要满足）：
  // 1. agent 进程自报成功（result 事件的 subtype === 'success'）；
  // 2. verify 检查全部通过；
  // 3. 回合数不超过 task 声明的 max_turns（若有声明）。
  const agentSucceeded = resultSubtype === 'success';

  const maxTurns = task.success_criteria?.max_turns;
  const turnsExceeded = typeof maxTurns === 'number' && turns > maxTurns;

  let checksPassed = 0;
  let checksFailed = 0;
  let harnessError: string | null = null;
  const verificationSkipped = !agentSucceeded;

  if (verificationSkipped) {
    // agent 没自报成功时，verify 从未执行。单独标记「跳过」，不要冒充 harness_error：
    // 超时/模型错误导致的未验证是运行失败，不是评测环境坏。
  } else if (task.verify) {
    const checkResults = await runChecks(task, repoDir);
    checksPassed = checkResults.filter((r) => r.passed).length;
    checksFailed = checkResults.filter((r) => !r.passed).length;
    // 任一检查命中环境故障特征 → 本次运行不可用于能力统计。
    const broken = checkResults.find((r) => r.harnessError !== null);
    if (broken) harnessError = broken.harnessError;
  }

  const result = {
    task_id: task.id,
    category: task.category,
    profile: profile.id,
    model: 'step-3.7-flash',
    provider: 'stepfun',
    step_pilot_commit: getGitCommit(),
    run_index: runIndex,
    success: agentSucceeded && checksFailed === 0 && !turnsExceeded && harnessError === null,
    duration_ms: durationMs,
    turns,
    tool_calls: toolCalls,
    tool_errors: toolErrors,
    retries,
    compactions,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    stop_reason: stopReason,
    failure_reason: failureReason,
    checks_passed: checksPassed,
    checks_failed: checksFailed,
    harness_error: harnessError,
    verification_skipped: verificationSkipped,
    events,
  };

  // Cleanup after verification so leftover handles from the agent run do not
  // block directory removal on Windows.
  await removeRepoDir(repoDir);

  return result;
}

function captureMetrics(
  ev: RawEvent,
  setters: {
    toolCalls: (updater: (v: number) => number) => void;
    toolErrors: (updater: (v: number) => number) => void;
    retries: (updater: (v: number) => number) => void;
    compactions: (updater: (v: number) => number) => void;
    inputTokens: (updater: (v: number) => number) => void;
    outputTokens: (updater: (v: number) => number) => void;
    totalTokens: (updater: (v: number) => number) => void;
    stopReason: (v: string | null) => void;
    failureReason: (v: string | null) => void;
    turns: (updater: (v: number) => number) => void;
    resultSubtype: (v: string | null) => void;
  },
) {
  switch (ev.type) {
    case 'thinking_start':
      setters.turns((v) => v + 1);
      break;
    case 'tool_start':
      setters.toolCalls((v) => v + 1);
      break;
    case 'tool_end': {
      const end = ev as { isError?: boolean };
      if (end.isError) setters.toolErrors((v) => v + 1);
      break;
    }
    case 'retry':
      setters.retries((v) => v + 1);
      break;
    case 'context.apply_compaction':
      setters.compactions((v) => v + 1);
      break;
    case 'usage': {
      const u = ev as { totalTokens?: number; billedDelta?: number };
      if (typeof u.totalTokens === 'number') setters.totalTokens((v) => u.totalTokens!);
      if (typeof u.billedDelta === 'number') setters.outputTokens((v) => v + u.billedDelta!);
      break;
    }
    case 'model.usage': {
      const mu = ev as {
        totalTokens?: number;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      };
      if (typeof mu.totalTokens === 'number') setters.totalTokens((v) => mu.totalTokens!);
      if (typeof mu.inputTokens === 'number') setters.inputTokens((v) => v + mu.inputTokens!);
      if (typeof mu.outputTokens === 'number') setters.outputTokens((v) => v + mu.outputTokens!);
      break;
    }
    case 'result':
      setters.resultSubtype((ev as { subtype?: string }).subtype ?? null);
      break;
    case 'error':
      setters.failureReason((ev as { message?: string }).message ?? 'error');
      setters.resultSubtype('error');
      break;
    case 'turn.issue': {
      const issue = ev as { kind?: string; message?: string };
      if (issue.kind === 'empty' || issue.kind === 'error') {
        setters.failureReason(issue.message ?? issue.kind ?? 'turn.issue');
      }
      break;
    }
    default:
      break;
  }
}

/**
 * 把父仓的 `node_modules` 以符号链接/junction 挂进任务 repo。
 *
 * 为什么需要：任务 repo 里没有 `node_modules`，而 Node 的模块解析虽然能一路上溯到
 * `./node_modules`（所以 `npx vitest run` 其实能跑起来），但**agent 看不见这一点**。
 * 实测（fixed-probe-1/2）中它执行 `ls node_modules/.bin/vitest` → 得到
 * "vitest not found in node_modules" → 据此判断「依赖没装」→ 去跑 `npm install`，
 * 白扔 3–4 个回合，并且在无网络环境下会直接失败。
 *
 * 这是**评测环境不真实**造成的额外难度，不是模型能力差异——真实项目里
 * `node_modules` 就在脚下。挂上链接后，任务 repo 的行为与一个正常安装过的
 * 项目完全一致，模型照常 `npx vitest run` 即可。
 *
 * 用 junction（Windows）/ dir 符号链接（POSIX）：失败不影响评测，
 * 因为向上解析仍然可用，只是拿不到「本地存在」的视觉信号。
 */
async function linkParentDeps(repoDir: string): Promise<void> {
  const { symlinkSync, existsSync: exists } = await import('node:fs');
  const parentModules = join(__dirname, '..', 'node_modules');
  const localModules = join(repoDir, 'node_modules');
  if (!exists(parentModules) || exists(localModules)) return;
  try {
    // Windows 上 dir 类型会自动落到 junction，无需管理员权限。
    symlinkSync(parentModules, localModules, process.platform === 'win32' ? 'junction' : 'dir');
  } catch { /* 拿不到本地信号也能靠向上解析跑，忽略 */ }
}

async function executeSetup(task: Task, repoDir: string): Promise<void> {
  const setupContent = task.setup;
  if (!setupContent) return;

  try {
    if (process.platform === 'win32') {
      const { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } = await import('node:fs');
      const { execSync } = await import('node:child_process');
      mkdirSync(repoDir, { recursive: true });
      const tmpDir = mkdtempSync(join(dirname(repoDir), 'bench-setup-'));
      const scriptPath = join(tmpDir, 'setup.sh');
      // Setup scripts compute TASK_DIR from $0; when copied to a temp file that
      // points to the temp path. Inject the real task directory instead.
      const taskDir = dirname(repoDir);
      // Git Bash on Windows requires MSYS-style paths for commands like mkdir.
      const msysTaskDir = '/d' + taskDir.slice(2).replace(/:/g, '');
      const fixedSetup = setupContent
        .replace(/^TASK_DIR=.*$/m, `TASK_DIR="${msysTaskDir}"`)
        .replace(/^REPO=.*$/m, `REPO="${msysTaskDir}/repo"`);
      writeFileSync(scriptPath, fixedSetup, 'utf8');
      try {
        const result = spawnSync('D:/Git/usr/bin/bash.exe', [scriptPath], {
          cwd: repoDir,
          encoding: 'utf8',
          stdio: 'pipe',
        });
        if (result.status !== 0) {
          const stderr = result.stderr?.toString() ?? '';
          const stdout = result.stdout?.toString() ?? '';
          throw new Error(`exit=${result.status} stderr=${stderr.slice(0, 500)} stdout=${stdout.slice(0, 200)}`);
        }
      } finally {
        // 清理临时脚本目录：mkdtempSync 建的目录必须显式删除，否则每次 Windows 运行
        // 都会在 task 目录下留下一个 bench-setup-XXXXXX（实测累积 230 个）。
        // 失败不影响评测结果，静默忽略即可。
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        // 把测试文件置为只读，避免 agent 改写测试来伪造成功。
        //
        // 这里原先是 `rmSync(file, { mode: 0o444 })`——**那是在删文件，不是在改权限**：
        // rmSync 只认 recursive / force / maxRetries 等选项，mode 被静默忽略，
        // 于是每个任务跑起来第一件事就是把测试文件删掉。后果是致命的：
        // setup.sh 刚 `git commit` 进去的 utils.test.ts 立即消失，agent 面对一个
        // 「没有任何测试」的仓库，只能自己写临时脚本自查（探针实测 14 回合里有 17 次
        // 工具调用是在找/复现测试），而 verify 的 `npx vitest run` 因
        // 「No test files found」退出 1，检查恒判失败——**改对了也是失败**。
        // 正确做法是用 chmodSync 改权限位。
        const testFiles = [
          join(repoDir, 'src', 'utils.test.ts'),
          join(repoDir, 'src', '__tests__', 'client.test.ts'),
          join(repoDir, 'src', '__tests__', 'checkout.test.ts'),
        ];
        for (const file of testFiles) {
          if (existsSync(file)) {
            try { chmodSync(file, 0o444); } catch { /* Windows 上可能无效，忽略 */ }
          }
        }
      }
    } else {
      const { execSync } = await import('node:child_process');
      execSync(setupContent, {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: 'pipe',
        shell: 'sh',
      });
    }
  } catch (err) {
    throw new Error(`Setup failed for task ${task.id}: ${err}`);
  }
}

/**
 * 单条检查的执行结果。区分「断言未通过」与「命令本身没跑起来」。
 * 类型与判据都定义在纯函数模块 harnessFailure.ts（便于单测，无需拉起 runner 的 IO）。
 */
type CheckResult = CheckOutcome;

async function runChecks(task: Task, repoDir: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of task.verify ?? []) {
    results.push(await executeCheck(check, repoDir));
  }

  return results;
}

async function executeCheck(check: { type: string; command?: string; path?: string; pattern?: string; expect?: Record<string, unknown> }, repoDir: string): Promise<CheckResult> {
  const name = check.type;
  switch (check.type) {
    case 'test': {
      const { execSync } = await import('node:child_process');
      let output = '';
      try {
        output = execSync(check.command ?? '', {
          cwd: repoDir,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (err) {
        // 失败分两类：断言没过（正常的评测结果）vs 命令根本没跑起来（框架故障）。
        // 后者必须单列，否则「环境坏了」会被读成「模型改错了」。
        const e = err as { stdout?: string; stderr?: string; status?: number };
        const combined = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
        const isHarness = isHarnessFailure(combined);
        output = combined;
        if (isHarness) {
          return { name, passed: false, harnessError: 'verify_exec_error' };
        }
        // 断言未通过：仍走下面的 expect 复核，让它给出确定结论。
        // （execSync 抛异常说明 exit_code !== 0，而这里声明的期望就是 0，
        //   所以直接判未通过；保留 expect 复核是为了 stdout_contains 语义完整。）
        if (check.expect?.stdout_contains && !output.includes(check.expect.stdout_contains as string)) {
          return { name, passed: false, harnessError: null };
        }
        return { name, passed: false, harnessError: null };
      }
      if (check.expect?.exit_code !== undefined && check.expect.exit_code !== 0) {
        return { name, passed: false, harnessError: null };
      }
      if (check.expect?.stdout_contains && !output.includes(check.expect.stdout_contains as string)) {
        return { name, passed: false, harnessError: null };
      }
      if (check.expect?.stderr_not_contains && output.toLowerCase().includes((check.expect.stderr_not_contains as string).toLowerCase())) {
        return { name, passed: false, harnessError: null };
      }
      return { name, passed: true, harnessError: null };
    }
    case 'file_contains': {
      const filePath = join(repoDir, check.path ?? '');
      // 路径不存在：可能是模型删了文件，也可能是 setup 没生成出来。
      // 前者是模型行为、后者是框架故障，无法从单点判断，故归为断言未通过并留证。
      if (!existsSync(filePath)) return { name, passed: false, harnessError: null };
      const content = readFileSync(filePath, 'utf8');
      const regex = check.pattern ? new RegExp(check.pattern) : null;
      return { name, passed: regex ? regex.test(content) : false, harnessError: null };
    }
    case 'file_not_contains': {
      const filePath = join(repoDir, check.path ?? '');
      if (!existsSync(filePath)) return { name, passed: true, harnessError: null };
      const content = readFileSync(filePath, 'utf8');
      const regex = check.pattern ? new RegExp(check.pattern) : null;
      return { name, passed: regex ? !regex.test(content) : true, harnessError: null };
    }
    case 'file_exists': {
      const filePath = join(repoDir, check.path ?? '');
      return { name, passed: existsSync(filePath), harnessError: null };
    }
    case 'command': {
      const { execSync } = await import('node:child_process');
      let output = '';
      try {
        output = execSync(check.command ?? '', {
          cwd: repoDir,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        const combined = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
        if (isHarnessFailure(combined)) {
          return { name, passed: false, harnessError: 'verify_exec_error' };
        }
        return { name, passed: false, harnessError: null };
      }
      if (check.expect?.stdout_contains && !output.includes(check.expect.stdout_contains as string)) {
        return { name, passed: false, harnessError: null };
      }
      return { name, passed: true, harnessError: null };
    }
    default:
      return { name, passed: false, harnessError: null };
  }
}

function getStepPilotCommand(): string {
  // Try the installed binary first, fall back to tsx dev mode
  const candidates = [
    join(__dirname, '..', 'dist', 'main.js'),
    join(__dirname, '..', 'node_modules', '.bin', 'step-pilot'),
    'step-pilot',
  ];

  for (const cmd of candidates) {
    if (cmd === 'step-pilot' || existsSync(cmd)) {
      return cmd;
    }
  }
  return 'step-pilot';
}
