/**
 * Mission 独立 verifier（P0-C）。
 *
 * 存在的唯一理由：把「完成」从「模型自报」变成「可被独立重跑的机器判定」。
 * 这是 Mission 头条不变量「模型可以失败，工程工作不能丢」在**收尾**处的落点——
 * 一只会喊「我做完了」的模型不算完成；必须有一次独立 verifier 跑通 `acceptance`
 * 命令、且**退出码符合预期**，才算。本模块就是那个独立 verifier。
 *
 * 两条刻意的分隔（对齐 benchmark 的 D1 教训，见 src/utils/harnessFailure.ts）：
 * 1. **退出码对照 accept**：`expectExit` 缺省 0；非零期望也支持（例如「命令必须失败才算对」）。
 * 2. **harness failure ≠ assertion failure**：命令非零退出且输出命中环境故障特征串时，
 *    判定为「环境坏了」而非「断言没过」。前者不可计入模型能力、也**绝不**把 Mission 置 failed
 *    （那会把一个框架 bug 洗白成「模型没做对」）。区分逻辑直接复用 isHarnessFailure，
 *    不在这里另起一套判据（避免 G7 复制漂移）。
 *
 * 纯函数 + 注入执行器：runVerifier 不碰 shell、不碰 IO，执行器完全可注入，
 * 所以单元测试可以用假执行器确定性覆盖全部分支，无需真跑命令。
 */
import { execFileSync } from 'node:child_process';
import { resolveShell, type ResolvedShell } from '../../tools/shellResolve.js';
import { isHarnessFailure } from '../../utils/harnessFailure.js';
import type { MissionAcceptance } from './types.js';

/** 内置 verifier 的稳定标识；将来支持多 verifier 时，verifierId 用于区分来源。 */
export const BUILTIN_VERIFIER_ID = 'step-pilot/verify';

/** 单条接受标准的执行结果。 */
export interface CheckResult {
  /** 执行的命令（原样回显，便于证据里复核）。 */
  command: string;
  /** 期望退出码。 */
  expectExit: number;
  /** 实际退出码；null = 命令根本没能启动（执行器自身抛错，如 shell 缺失）。 */
  exitCode: number | null;
  /** 是否通过（实际退出码 === 期望退出码）。harness 故障恒为 false。 */
  passed: boolean;
  /** 标准输出（过长会被截断，完整版在证据文件）。 */
  stdout: string;
  /** 标准错误（过长会被截断，完整版在证据文件）。 */
  stderr: string;
  /** 非 null = 命中环境故障分类；null = 正常断言未通过（或通过了）。 */
  harnessError: string | null;
}

/** 一次完整验证的结果。 */
export interface VerificationResult {
  verifierId: string;
  /** 全部检查通过且无非结论性环境故障。false 时**不得**据此置 completed。 */
  allPassed: boolean;
  /** 是否有任一检查因环境故障而不可判定——此时 allPassed 恒为 false，且结论不可采信。 */
  harnessError: boolean;
  checks: CheckResult[];
}

/** 命令执行器：输入命令字符串，返回退出码与输出。可注入以做确定性测试。 */
export type VerifyExecutor = (command: string) => { exitCode: number; stdout: string; stderr: string };

/** 证据/展示时截断的单个输出上限（完整输出仍落在证据文件）。 */
const MAX_OUTPUT_CHARS = 20_000;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${s.length - MAX_OUTPUT_CHARS} chars]`;
}

/** 把一段合并输出归类成简短的 harness 故障名（命中即环境故障，不是断言失败）。 */
function classifyHarness(combined: string): string {
  const m =
    /No test files found|Cannot find module|UNRESOLVED_IMPORT|Startup Error|command not found|is not recognized|ENOENT/i.exec(
      combined,
    );
  return m !== null ? m[0] : 'harness error';
}

/**
 * 执行单条接受标准。
 *
 * 分类优先级：启动失败（executor 抛错）→ 环境故障；否则比对退出码 → passed；
 * passed 为 false 时用 isHarnessFailure 判断是「环境坏了」还是「断言没过」。
 */
export function runCheck(acceptance: MissionAcceptance, executor: VerifyExecutor): CheckResult {
  let out: { exitCode: number; stdout: string; stderr: string };
  try {
    out = executor(acceptance.command);
  } catch (e) {
    // 执行器自身异常（如 shell 缺失导致 spawn 失败）——按环境故障处理，不当成断言失败
    const msg = e instanceof Error ? e.message : String(e);
    return {
      command: acceptance.command,
      expectExit: acceptance.expectExit,
      exitCode: null,
      passed: false,
      stdout: '',
      stderr: msg,
      harnessError: isHarnessFailure(msg) ? classifyHarness(msg) : 'executor threw before the command ran',
    };
  }
  const passed = out.exitCode === acceptance.expectExit;
  const combined = `${out.stdout}\n${out.stderr}`;
  const harnessError = passed ? null : isHarnessFailure(combined) ? classifyHarness(combined) : null;
  return {
    command: acceptance.command,
    expectExit: acceptance.expectExit,
    exitCode: out.exitCode,
    passed,
    stdout: truncate(out.stdout),
    stderr: truncate(out.stderr),
    harnessError,
  };
}

/**
 * 执行整组接受标准。
 *
 * @param executor 可注入；缺省走 defaultExecutor（真 shell）。测试传假执行器即可确定性覆盖。
 */
export function runVerifier(
  acceptance: readonly MissionAcceptance[],
  opts: { executor: VerifyExecutor; verifierId?: string },
): VerificationResult {
  const checks = acceptance.map((a) => runCheck(a, opts.executor));
  const harnessError = checks.some((c) => c.harnessError !== null);
  const allPassed = checks.every((c) => c.passed);
  return {
    verifierId: opts.verifierId ?? BUILTIN_VERIFIER_ID,
    // harness 故障意味着「无法确认通过」，所以 allPassed 必须随之 falsy，且调用方不得据此置 completed
    allPassed: allPassed && !harnessError,
    harnessError,
    checks,
  };
}

/**
 * 默认执行器：用 resolveShell 选定解释器，execFileSync 跑整条命令。
 *
 * shell 缺失（family === 'none'）时**抛错**而非静默失败——对齐 shellResolve 的口径：
 * 没有可用 shell 就如实报错引导装 Git Bash，而不是用 cmd.exe 兜底跑出一堆假失败。
 * 调用方（cmdVerify）捕获后把 Mission 留在原状态、不写 verifying。
 */
export function defaultExecutor(cwd: string): VerifyExecutor {
  const shell: ResolvedShell = resolveShell();
  if (shell.family === 'none') {
    throw new Error(
      '未检测到可用 shell（Git Bash / WSL / busybox / PowerShell 皆不可用），无法执行接受标准命令。请安装 Git for Windows 以获取 Git Bash。',
    );
  }
  return (command) => {
    try {
      const stdout = execFileSync(shell.cmd, shell.args(command), {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as string;
      return { exitCode: 0, stdout: stdout ?? '', stderr: '' };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
      const exitCode = typeof err.status === 'number' ? err.status : 1;
      const stdout = typeof err.stdout === 'string' ? err.stdout : '';
      const stderr = typeof err.stderr === 'string' ? err.stderr : err.message ?? '';
      return { exitCode, stdout, stderr };
    }
  };
}
