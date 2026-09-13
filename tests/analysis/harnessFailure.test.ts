import { describe, it, expect } from 'vitest';
import { isHarnessFailure } from '../../benchmark/harnessFailure.js';

/**
 * 评测框架故障判据。
 *
 * 这组测试守的是**归因正确性**，不是字符串匹配本身：
 * 判错的代价是双向的，两边都很贵——
 * - 漏判（把框架故障读成模型失败）：一个评测 bug 会被写成「模型能力下降」，
 *   本仓真实发生过（见 benchmark/HARNESS-AUDIT.md D1）；
 * - 误判（把模型失败读成框架故障）：真实失败被洗白成「环境问题」，
 *   比漏判更危险，因为它会让指标永远好看。
 * 所以下面既有拦截面，也有**必须不拦**的面。
 */

describe('isHarnessFailure — 必须拦住的真实样本', () => {
  it('vitest 找不到测试文件（D1 的直接后果，实测可复现）', () => {
    // 这是 D1 修复前每个任务都会走到的分支：
    // rmSync 误删 utils.test.ts → vitest 报这句话 → 恒判失败
    expect(
      isHarnessFailure('No test files found, exiting with code 1\ninclude: **/*.{test,spec}.?(c|m)[jt]s?(x)'),
    ).toBe(true);
  });

  it('模块解析失败：vitest/config 找不到', () => {
    expect(isHarnessFailure("Error: Cannot find module 'vitest/config'")).toBe(true);
  });

  it('vite 的 UNRESOLVED_IMPORT（措辞与 Cannot find module 不同，需单列）', () => {
    expect(isHarnessFailure("vitest.config.ts (1:344) [UNRESOLVED_IMPORT] Could not resolve 'vitest/config'")).toBe(
      true,
    );
  });

  it('vitest 启动阶段就挂掉（测试根本没开始跑）', () => {
    expect(isHarnessFailure('failed to load config\nStartup Error')).toBe(true);
  });

  it('POSIX shell 找不到命令', () => {
    expect(isHarnessFailure('bash: npx: command not found')).toBe(true);
  });

  it('Windows shell 找不到命令（同一语义的不同措辞）', () => {
    expect(isHarnessFailure("'npx' is not recognized as an internal or external command")).toBe(true);
  });

  it('ENOENT（setup 没生成出预期结构）', () => {
    expect(isHarnessFailure('ENOENT: no such file or directory, open .../package.json')).toBe(true);
  });

  it('大小写不敏感（vitest 输出大小写不稳定）', () => {
    expect(isHarnessFailure('no test files found')).toBe(true);
    expect(isHarnessFailure('CANNOT FIND MODULE')).toBe(true);
  });
});

describe('isHarnessFailure — 必须不拦（真实失败不能被洗白）', () => {
  it('断言未通过：测试跑了但挂了', () => {
    expect(
      isHarnessFailure('FAIL  src/utils.test.ts > sum > sums an array\nAssertionError: expected NaN to be 6'),
    ).toBe(false);
  });

  it('断言未通过（中文措辞）', () => {
    expect(isHarnessFailure('AssertionError: 期望 3 但收到 6')).toBe(false);
  });

  it('测试超时导致的失败属于模型侧（改得太慢/死循环）', () => {
    expect(isHarnessFailure('Test timed out in 5000ms.')).toBe(false);
  });

  it('空输出不判为框架故障（无从判断，宁可算作模型失败）', () => {
    expect(isHarnessFailure('')).toBe(false);
  });

  it('普通的测试计数不符（stdout_contains 未命中）', () => {
    expect(isHarnessFailure('Test Files  1 passed (1)\nTests  2 passed (2)')).toBe(false);
  });

  it('模型自己写的脚本报错（属模型行为，非环境故障）', () => {
    expect(isHarnessFailure('SyntaxError: Unexpected token } in verify.ts')).toBe(false);
  });
});
