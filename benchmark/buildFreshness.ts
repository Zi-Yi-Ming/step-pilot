/**
 * benchmark 构建新鲜度守卫。
 *
 * ## 它防的是一次真实发生的事故
 *
 * 给 CLI 加了 `--config` 之后没有重新 build，`pnpm benchmark run` 照常跑完了
 * 50 个 run，**49 个失败**。原因是 benchmark 优先 spawn `dist/main.js`，而那个构建
 * 比 src 旧；`cli.ts` 又开了 `.allowUnknownOption(true)`，于是 `--config <path>`
 * 被当成未知选项吞掉、`<path>` 沦为一个位置参数——也就是 **prompt**。
 *
 * agent 拿到一个临时配置文件的路径当任务，自然跑去读配置、然后宣布"已完成"。
 * 49/50 的失败率看起来像"小模型干不了这活"，实际是构建过期。
 *
 * 这与 benchmark 审计里 D1 是同一类事故：**缺陷不在结论里，在通往结论的路上**。
 * 区别在于 D1 至少会留下痕迹，而这次连报错都没有。
 *
 * ## 为什么用 mtime 而不是 commit
 *
 * commit 比对只能发现"没提交的改动"，发现不了"改了 src 但没重新 build"这个
 * 最常见的状态。mtime 直接比对构建产物与源码的新旧， dirty 工作树也能抓住。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export class StaleBuildError extends Error {
  constructor(
    readonly distPath: string,
    readonly newestSource: string,
  ) {
    super(
      `benchmark 要跑的是过期构建：\n` +
        `  dist:      ${distPath}\n` +
        `  最新源码:  ${newestSource}\n\n` +
        `源码比构建产物新，跑出来的结果不描述当前代码。\n` +
        `更糟的是未知 CLI 参数可能被静默吞掉、把值变成 prompt——那会得到\n` +
        `一堆看起来像「模型失败」的垃圾数据。\n\n` +
        `先执行 pnpm run build 再跑 benchmark。`,
    );
    this.name = 'StaleBuildError';
  }
}

/** 递归找出目录下最新的文件 mtime（毫秒）。 */
function newestMtime(dir: string): { ms: number; path: string } {
  let best = { ms: 0, path: dir };
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return best;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const sub = newestMtime(p);
      if (sub.ms > best.ms) best = sub;
    } else if (e.isFile()) {
      try {
        const ms = statSync(p).mtimeMs;
        if (ms > best.ms) best = { ms, path: p };
      } catch {
        // 读不到 mtime 的文件跳过
      }
    }
  }
  return best;
}

/** 纯函数：给定构建产物与源码目录，返回 { stale, newestSource }。 */
export function checkBuildFreshness(root: string): { stale: boolean; newestSource: string; distMs: number } {
  const distPath = join(root, 'dist', 'main.js');
  const distMs = existsSync(distPath) ? statSync(distPath).mtimeMs : 0;
  const newest = newestMtime(join(root, 'src'));
  return { stale: distMs === 0 || newest.ms > distMs, newestSource: newest.path, distMs };
}

/** 构建过期就抛错；新鲜则静默返回。 */
export function assertFreshBuild(root: string): void {
  const r = checkBuildFreshness(root);
  if (r.stale) {
    throw new StaleBuildError(join(root, 'dist', 'main.js'), r.newestSource);
  }
}
