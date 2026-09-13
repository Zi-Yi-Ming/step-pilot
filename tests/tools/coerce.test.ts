import { describe, expect, it } from 'vitest';
import { coerceToolResult, executeTool } from '../../src/tools/index.js';

describe('coerceToolResult', () => {
  it('合法 ToolResult 原样返回', () => {
    expect(coerceToolResult({ content: 'x', isError: false })).toEqual({
      content: 'x',
      isError: false,
    });
  });

  it('字符串转成非错误结果', () => {
    expect(coerceToolResult('hi')).toEqual({ content: 'hi', isError: false });
  });

  it('undefined / 畸形值转成错误结果', () => {
    expect(coerceToolResult(undefined).isError).toBe(true);
    expect(coerceToolResult(42).isError).toBe(true);
    expect(coerceToolResult({ foo: 1 }).isError).toBe(true);
  });
});

describe('executeTool 错误回灌', () => {
  const ctx = { cwd: process.cwd() };

  it('未知工具返回 isError 而非抛出', async () => {
    const r = await executeTool('does_not_exist', {}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('未知工具');
  });

  it('未知工具错误带上可用工具清单（G2 恢复信息）', async () => {
    const r = await executeTool('read_fil', {}, ctx);
    expect(r.isError).toBe(true);
    // 不再是光秃秃一行：清单必须出现，且拼错的 read_file 应被识别为近似候选
    expect(r.content).toContain('可用工具：');
    expect(r.content).toContain('read_file');
    expect(r.content).toContain('是否想用 nearest：read_file');
  });

  it('experimental 关闭时恢复提示不含隐藏工具（不宣传模型拿不到的工具）', async () => {
    // 默认 ctx 未开 experimentalToolsEnabled，team_init 属 experimental tier
    const r = await executeTool('teaminit', {}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain('team_init');
  });

  it('入参校验失败返回 isError', async () => {
    // read_file 需要 path:string，这里给错误类型
    const r = await executeTool('read_file', { path: 123 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('校验失败');
  });
});
