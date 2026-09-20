/**
 * 构建新鲜度守卫测试。
 *
 * 背景是一次真实事故：加了 `--config` 忘了 rebuild，benchmark 照常跑完 50 个 run、
 * 失败 49 个、全程无报错——因为 `cli.ts` 开了 `allowUnknownOption(true)`，
 * `--config <path>` 被吞、`<path>` 变成 prompt。98% 的失败率看起来像
 * "小模型干不了这活"，实际是构建过期。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StaleBuildError, assertFreshBuild, checkBuildFreshness } from '../../benchmark/buildFreshness.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fresh-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 给文件设一个明确的 mtime（秒）。 */
function touch(path: string, ms: number): void {
  const d = new Date(ms);
  utimesSync(path, d, d);
}

describe('checkBuildFreshness', () => {
  it('构建比源码新 → 不陈旧', () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    writeFileSync(join(root, 'dist', 'main.js'), 'x');
    touch(join(root, 'src', 'a.ts'), 1000);
    touch(join(root, 'dist', 'main.js'), 2000);
    expect(checkBuildFreshness(root).stale).toBe(false);
  });

  it('源码比构建新 → 陈旧，并指出最新那个源码文件', () => {
    writeFileSync(join(root, 'src', 'old.ts'), 'x');
    writeFileSync(join(root, 'src', 'new.ts'), 'x');
    writeFileSync(join(root, 'dist', 'main.js'), 'x');
    touch(join(root, 'src', 'old.ts'), 1000);
    touch(join(root, 'src', 'new.ts'), 3000);
    touch(join(root, 'dist', 'main.js'), 2000);
    const r = checkBuildFreshness(root);
    expect(r.stale).toBe(true);
    expect(r.newestSource).toBe(join(root, 'src', 'new.ts'));
  });

  it('构建产物不存在 → 陈旧', () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    expect(checkBuildFreshness(root).stale).toBe(true);
  });

  it('递归进子目录找最新源码', () => {
    mkdirSync(join(root, 'src', 'agent'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    writeFileSync(join(root, 'src', 'agent', 'deep.ts'), 'x');
    writeFileSync(join(root, 'dist', 'main.js'), 'x');
    touch(join(root, 'src', 'a.ts'), 1000);
    touch(join(root, 'src', 'agent', 'deep.ts'), 5000);
    touch(join(root, 'dist', 'main.js'), 4000);
    expect(checkBuildFreshness(root).stale).toBe(true);
    expect(checkBuildFreshness(root).newestSource).toContain('deep.ts');
  });

  it('跳过 node_modules 与 .git，不让依赖文件误报陈旧', () => {
    mkdirSync(join(root, 'src', 'node_modules'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    writeFileSync(join(root, 'src', 'node_modules', 'dep.ts'), 'x');
    writeFileSync(join(root, 'dist', 'main.js'), 'x');
    touch(join(root, 'src', 'a.ts'), 1000);
    touch(join(root, 'src', 'node_modules', 'dep.ts'), 9999);
    touch(join(root, 'dist', 'main.js'), 2000);
    expect(checkBuildFreshness(root).stale).toBe(false);
  });
});

describe('assertFreshBuild', () => {
  it('新鲜时静默通过', () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    writeFileSync(join(root, 'dist', 'main.js'), 'x');
    touch(join(root, 'src', 'a.ts'), 1000);
    touch(join(root, 'dist', 'main.js'), 2000);
    expect(() => assertFreshBuild(root)).not.toThrow();
  });

  it('过期时抛 StaleBuildError，且信息里给出可执行的下一步', () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    writeFileSync(join(root, 'dist', 'main.js'), 'x');
    touch(join(root, 'src', 'a.ts'), 3000);
    touch(join(root, 'dist', 'main.js'), 2000);
    expect(() => assertFreshBuild(root)).toThrow(StaleBuildError);
    let msg = '';
    try {
      assertFreshBuild(root);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('pnpm run build');
    // 必须点明后果，否则使用者只会把它当成碍事的检查
    expect(msg).toContain('模型失败');
  });

  it('报错信息带上具体是哪个源码文件新于构建', () => {
    writeFileSync(join(root, 'src', 'cli.ts'), 'x');
    writeFileSync(join(root, 'dist', 'main.js'), 'x');
    touch(join(root, 'src', 'cli.ts'), 3000);
    touch(join(root, 'dist', 'main.js'), 2000);
    try {
      assertFreshBuild(root);
      expect.unreachable('应当抛错');
    } catch (e) {
      expect((e as Error).message).toContain('cli.ts');
    }
  });
});
