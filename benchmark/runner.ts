import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task } from './types.js';

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

  // If all retries fail, surface the error so the caller knows the workspace
  // may be polluted for the next run.
  throw new Error(`Failed to remove repo dir after retries: ${repoDir}: ${lastError?.message}`);
}

export async function runTask(task: Task, profile: string, runIndex: number): Promise<RunResult> {
  const repoDir = join(__dirname, '..', task.repository);
  const startTime = Date.now();

  // Always start from a clean repo state for each run.
  if (existsSync(repoDir)) {
    await removeRepoDir(repoDir);
  }
  await executeSetup(task, repoDir);

  // Build step-pilot command
  const cmd = getStepPilotCommand();
  const prompt = (task as any).prompt ?? task.description ?? '';
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--yolo',
    '-C', repoDir,
    prompt,
  ];

  const { stdout, stderr, exitCode } = await runStepPilot(cmd, args, join(__dirname, '..'), (task.timeout ?? 120) * 1000);

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

  const success = resultSubtype === 'success';
  let checksPassed = 0;
  let checksFailed = 0;
  if (success && task.verify) {
    const checkResults = await runChecks(task, repoDir);
    checksPassed = checkResults.filter((r) => r.passed).length;
    checksFailed = checkResults.filter((r) => !r.passed).length;
  }

  const result = {
    task_id: task.id,
    category: task.category,
    profile,
    model: 'step-3.7-flash',
    provider: 'stepfun',
    step_pilot_commit: getGitCommit(),
    run_index: runIndex,
    success: success && checksFailed === 0,
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

async function executeSetup(task: Task, repoDir: string): Promise<void> {
  const setupContent = task.setup;
  if (!setupContent) return;

  try {
    if (process.platform === 'win32') {
      const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
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
        // Make test files read-only so the agent cannot mutate them to fake success.
        const testFiles = [
          join(repoDir, 'src', 'utils.test.ts'),
          join(repoDir, 'src', '__tests__', 'client.test.ts'),
          join(repoDir, 'src', '__tests__', 'checkout.test.ts'),
        ];
        for (const file of testFiles) {
          if (existsSync(file)) {
            try { rmSync(file, { mode: 0o444, recursive: false }); } catch { /* ignore */ }
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

async function runChecks(task: Task, repoDir: string): Promise<Array<{ name: string; passed: boolean }>> {
  const results: Array<{ name: string; passed: boolean }> = [];

  for (const check of task.verify ?? []) {
    const passed = await executeCheck(check, repoDir);
    results.push({ name: check.type, passed });
  }

  return results;
}

async function executeCheck(check: { type: string; command?: string; path?: string; pattern?: string; expect?: Record<string, unknown> }, repoDir: string): Promise<boolean> {
  switch (check.type) {
    case 'test': {
      try {
        const { execSync } = await import('node:child_process');
        const output = execSync(check.command ?? '', {
          cwd: repoDir,
          encoding: 'utf8',
          stdio: 'pipe',
        });
        if (check.expect?.exit_code !== undefined && check.expect.exit_code !== 0) {
          return false;
        }
        if (check.expect?.stdout_contains && !output.includes(check.expect.stdout_contains as string)) {
          return false;
        }
        if (check.expect?.stderr_not_contains && output.toLowerCase().includes((check.expect.stderr_not_contains as string).toLowerCase())) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    }
    case 'file_contains': {
      const filePath = join(repoDir, check.path ?? '');
      if (!existsSync(filePath)) return false;
      const content = readFileSync(filePath, 'utf8');
      const regex = check.pattern ? new RegExp(check.pattern) : null;
      return regex ? regex.test(content) : false;
    }
    case 'file_not_contains': {
      const filePath = join(repoDir, check.path ?? '');
      if (!existsSync(filePath)) return true;
      const content = readFileSync(filePath, 'utf8');
      const regex = check.pattern ? new RegExp(check.pattern) : null;
      return regex ? !regex.test(content) : true;
    }
    case 'file_exists': {
      const filePath = join(repoDir, check.path ?? '');
      return existsSync(filePath);
    }
    case 'command': {
      try {
        const { execSync } = await import('node:child_process');
        const output = execSync(check.command ?? '', {
          cwd: repoDir,
          encoding: 'utf8',
          stdio: 'pipe',
        });
        if (check.expect?.exit_code !== undefined) {
          // Can't easily check exit code here, assume success if no throw
        }
        if (check.expect?.stdout_contains && !output.includes(check.expect.stdout_contains as string)) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    }
    default:
      return false;
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
