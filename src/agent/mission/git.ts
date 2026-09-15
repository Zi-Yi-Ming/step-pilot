/**
 * Mission 的 git 探测：只回答「这个检查点之后仓库动了什么」。
 *
 * 为什么没有直接复用 `agent/team/git.ts`：那里的封装面向 worktree 生命周期
 * （增删工作间、合并、typecheck），失败一律抛 `TeamError`——把 team 的领域错误
 * 泄进 Mission 的调用栈会让人误判故障归属。这里只需要四个只读探测，且**一律不抛错**：
 * 探测失败返回 `available: false`，由调用方如实展示「无法判定漂移」，而不是让
 * `mission resume` 直接崩掉。
 *
 * （共享的 git 包装层是已知的复制漂移债务 G7，抽公共 util 属独立重构，不在本轮混做。）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 一次探测的结果。`available: false` 表示目录不是 git 仓、或 git 不可用。 */
export interface GitInspection {
  available: boolean;
  /** 当前 HEAD 的完整 sha。 */
  head?: string;
  /** 自 `sinceSha` 以来**提交层面**的变更文件（相对仓根）。 */
  committedChanges?: string[];
  /** 工作区是否有未提交改动。 */
  dirty?: boolean;
  /** 工作区未提交的变更文件（含未跟踪）。 */
  uncommittedChanges?: string[];
  /** 探测失败时的原因摘要（available: false 时有值）。 */
  note?: string;
}

/** git 子进程的硬超时：探测是只读快路径，卡住说明环境异常，不该拖着 resume 一起等。 */
const GIT_TIMEOUT_MS = 10_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout.trim();
}

function lines(out: string): string[] {
  return out === '' ? [] : out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * 探测仓库状态。
 *
 * @param repo     仓库路径（或仓内任意子目录）
 * @param sinceSha 检查点记录的 HEAD；给出时同时算出「自那以后提交层面的变更」。
 *                 undefined = 没有可比较的基线，只报当前 HEAD 与工作区状态。
 */
export async function probeGit(repo: string, sinceSha?: string): Promise<GitInspection> {
  try {
    const inside = await git(repo, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') {
      return { available: false, note: '不在 git 工作区内' };
    }
  } catch (e) {
    return { available: false, note: shortError(e) };
  }

  let head: string | undefined;
  try {
    head = await git(repo, ['rev-parse', 'HEAD']);
  } catch {
    // 空仓（尚无提交）：不是错误，只是没有 HEAD 可比
    head = undefined;
  }

  const out: GitInspection = { available: true };
  if (head !== undefined) out.head = head;

  // 工作区状态：porcelain 的第一列/第二列都是改动，含未跟踪（??）
  try {
    const porcelain = await git(repo, ['status', '--porcelain']);
    const changed = lines(porcelain).map((l) => l.slice(3).trim()).filter(Boolean);
    out.dirty = changed.length > 0;
    out.uncommittedChanges = changed;
  } catch (e) {
    out.note = shortError(e);
  }

  if (sinceSha !== undefined && sinceSha !== '' && head !== undefined) {
    try {
      // 用 `sha..HEAD` 而不是 `sha...HEAD`：前者是「从该点线性走到 HEAD 的差异」，
      // 正是「检查点之后提交了什么」的语义；三点形式会引入 merge-base，在分支切换
      // 过的仓库里给出与直觉不符的结果。
      out.committedChanges = lines(await git(repo, ['diff', '--name-only', `${sinceSha}..HEAD`]));
    } catch (e) {
      // sinceSha 可能已不可达（rebase / gc）——如实标注，不假装无漂移
      out.note = `无法比较检查点 ${sinceSha.slice(0, 8)}：${shortError(e)}`;
    }
  }

  return out;
}

function shortError(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr ?? err.message ?? '未知错误').trim().split('\n').slice(0, 2).join(' ').slice(0, 200);
}
