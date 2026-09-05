import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  collectFullSuiteCandidates,
  isFilteredVitestCommand,
  parseVitestCounts,
  pickPostGreen,
  type FullSuiteCandidate,
} from '../../src/agent/postGreen.js';

const GREEN = ' Tests  0 failed | 12 passed (12)';
const FAIL10 = ' Test Files  1 failed (1)\n      Tests  10 failed | 2 passed (12)';

/** 构造 assistant（bash tool_use）+ user（tool_result）消息对。 */
function pair(command: string, resultText: string, id = 't1'): [Anthropic.MessageParam, Anthropic.MessageParam] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'bash', input: { command } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: resultText }] },
  ];
}

describe('isFilteredVitestCommand（镜像封板 isFilteredVitestRun）', () => {
  it('裸 run + flags + 重定向 = 全量', () => {
    expect(isFilteredVitestCommand('npx vitest run')).toBe(false);
    expect(isFilteredVitestCommand('cd repo && npx vitest run 2>&1')).toBe(false);
    expect(isFilteredVitestCommand('npx vitest run --reporter=verbose 2>&1 | head -30')).toBe(false);
  });

  it('路径位置参数 / -t / --testNamePattern = 过滤', () => {
    expect(isFilteredVitestCommand('npx vitest run src/__tests__/debug.test.ts')).toBe(true);
    expect(isFilteredVitestCommand('npx vitest run -t "cache miss" 2>&1')).toBe(true);
    expect(isFilteredVitestCommand('npx vitest run --reporter=verbose -t "creates task"')).toBe(true);
  });

  it('非 vitest run 命令按不可比处理', () => {
    expect(isFilteredVitestCommand('cat vitest.config.ts')).toBe(true);
    expect(isFilteredVitestCommand('echo done')).toBe(true);
  });
});

describe('parseVitestCounts（镜像封板 parseTestCounts）', () => {
  it('底部测试级汇总优先，文件级行不污染', () => {
    expect(parseVitestCounts(` Test Files  1 failed (1)\n${GREEN}\n`)).toEqual({ failed: 0, passed: 12, total: 12 });
  });

  it('全绿形态与仅 failed 形态', () => {
    expect(parseVitestCounts('Tests  12 passed (12)')).toEqual({ failed: 0, passed: 12, total: 12 });
    expect(parseVitestCounts('Tests  12 failed (12)')).toEqual({ failed: 12, passed: 0, total: 12 });
  });

  it('ANSI 分隔照样可读；横幅兜底 total=0', () => {
    expect(parseVitestCounts('Tests  \x1b[31m10 failed\x1b[22m | \x1b[33m2 passed\x1b[22m (12)')).toEqual({ failed: 10, passed: 2, total: 12 });
    expect(parseVitestCounts(' ⎯ Failed Tests 10 ⎯\n × creates task 3ms\n')).toEqual({ failed: 10, passed: 0, total: 0 });
  });

  it('no tests / 只有文件级行 / 空 → null', () => {
    expect(parseVitestCounts('Test Files  1 failed (1)\n Tests  no tests\n')).toBeNull();
    expect(parseVitestCounts('Test Files  1 failed (1)\n')).toBeNull();
    expect(parseVitestCounts('')).toBeNull();
  });
});

describe('collectFullSuiteCandidates', () => {
  it('全量 vitest 绿 → 一个 green 候选', () => {
    const [a, u] = pair('npx vitest run 2>&1', `noise\n${GREEN}`);
    expect(collectFullSuiteCandidates(a, u)).toEqual([{ toolUseId: 't1', failed: 0, passed: 12, total: 12 }]);
  });

  it('filtered test（-t / 路径）→ 无候选', () => {
    for (const cmd of [
      'npx vitest run -t "cache miss" 2>&1',
      'npx vitest run src/__tests__/debug.test.ts',
    ]) {
      const [a, u] = pair(cmd, ' Test Files  1 passed (1)\n Tests  1 passed | 11 skipped (12)\n');
      expect(collectFullSuiteCandidates(a, u)).toEqual([]);
    }
  });

  it('failed tests → 候选存在但非 green', () => {
    const [a, u] = pair('npx vitest run', FAIL10);
    const c = collectFullSuiteCandidates(a, u);
    expect(c).toHaveLength(1);
    expect(c[0]!.failed).toBe(10);
    expect(pickPostGreen(c, 0)).toBeNull();
  });

  it('结果被中间截断但汇总行保留 → 仍可判绿', () => {
    const truncated = 'x'.repeat(6000) + '\n[截断标记]\n' + 'y'.repeat(4000) + `\n${GREEN}`;
    const [a, u] = pair('npx vitest run', truncated);
    expect(collectFullSuiteCandidates(a, u)).toEqual([{ toolUseId: 't1', failed: 0, passed: 12, total: 12 }]);
  });

  it('汇总行整体丢失（截断过狠）→ 无候选（安全 no-trigger）', () => {
    const [a, u] = pair('npx vitest run', 'output without any summary line');
    expect(collectFullSuiteCandidates(a, u)).toEqual([]);
  });

  it('tool_result 文本块数组形态照样可读；非 bash / 角色错乱 → 空', () => {
    const a: Anthropic.MessageParam = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npx vitest run' } }] };
    const u: Anthropic.MessageParam = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: GREEN }] }] };
    expect(collectFullSuiteCandidates(a, u)).toHaveLength(1);
    const wrongRole: Anthropic.MessageParam = { role: 'user', content: [] };
    expect(collectFullSuiteCandidates(wrongRole, u)).toEqual([]);
  });
});

describe('pickPostGreen（suite 不收缩守卫）', () => {
  const c = (failed: number, total: number): FullSuiteCandidate => ({ toolUseId: 'x', failed, passed: total - failed, total });

  it('suite 收缩（total < maxSuiteTotal）→ 不触发', () => {
    expect(pickPostGreen([c(0, 12)], 13)).toBeNull();
  });

  it('total >= maxSuiteTotal 且全绿 → 触发；首绿 maxSuiteTotal=0 → 触发', () => {
    expect(pickPostGreen([c(0, 12)], 12)).toEqual(c(0, 12));
    expect(pickPostGreen([c(0, 12)], 0)).toEqual(c(0, 12));
  });

  it('failed > 0 永不触发；banner-only（passed=0）永不触发——真全绿必有底部 passed 行', () => {
    expect(pickPostGreen([c(10, 12)], 0)).toBeNull();
    expect(pickPostGreen([c(0, 0)], 5)).toBeNull();
    expect(pickPostGreen([c(0, 0)], 0)).toBeNull(); // 横幅形态不可能表达「全绿」
  });

  it('混合批次：先红后绿，取绿者', () => {
    expect(pickPostGreen([c(10, 12), c(0, 12)], 12)).toEqual(c(0, 12));
  });
});
