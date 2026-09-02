import { describe, it, expect } from 'vitest';
import { preprocessToolResult } from '../../src/agent/toolResultPreprocess.js';

const mkResult = (content: string, isError = false) => ({ content, isError });

describe('preprocessToolResult', () => {
  it('短内容直接返回同一引用', () => {
    const r = mkResult('hello');
    expect(preprocessToolResult(r, 'bash')).toBe(r);
  });

  it('非 string content 原样返回', () => {
    const r = { content: 123 as never, isError: false };
    expect(preprocessToolResult(r, 'read_file')).toBe(r);
  });

  it('bash 长输出保留头 50 + 尾 20', () => {
    const chunk = 'x'.repeat(1000);
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1} ${chunk}`);
    const r = mkResult(lines.join('\n'));
    const out = preprocessToolResult(r, 'bash');
    expect(out).not.toBe(r);
    expect(out.content).toContain('line 1');
    expect(out.content).toContain('line 101');
    expect(out.content).not.toContain('line 51');
    expect(out.content).toContain('50 lines omitted');
  });

  it('read_file 长输出保留头 10 + 尾 5 段', () => {
    const chunk = 'p'.repeat(5000);
    const paragraphs = Array.from({ length: 20 }, (_, i) => `para ${i + 1} ${chunk}`).join('\n\n');
    const r = mkResult(paragraphs);
    const out = preprocessToolResult(r, 'read_file');
    expect(out).not.toBe(r);
    expect(out.content).toContain('para 1');
    expect(out.content).toContain('para 16');
    expect(out.content).not.toContain('para 11');
    expect(out.content).toContain('5 paragraphs omitted');
  });

  it('非 bash/read_file 的长输出不处理', () => {
    const long = 'x'.repeat(60_000);
    const r = mkResult(long);
    const out = preprocessToolResult(r, 'web_fetch');
    expect(out).toBe(r);
  });
});

describe('preprocessToolResult: MCP 工具', () => {
  it('mcp__ 前缀的超长输出按行截断（外部工具结构不可知，取行级最大公约数）', () => {
    const chunk = 'd'.repeat(1000);
    const lines = Array.from({ length: 120 }, (_, i) => `mcp line ${i + 1} ${chunk}`);
    const r = mkResult(lines.join('\n'));
    const out = preprocessToolResult(r, 'mcp__remote__fetch_data');
    expect(out).not.toBe(r);
    expect(out.content).toContain('mcp line 1');
    expect(out.content).toContain('mcp line 101');
    expect(out.content).not.toContain('mcp line 51');
    expect(out.content).toContain('50 lines omitted');
  });

  it('mcp__ 前缀的短输出不处理', () => {
    const r = mkResult('small result');
    expect(preprocessToolResult(r, 'mcp__remote__fetch_data')).toBe(r);
  });
});
