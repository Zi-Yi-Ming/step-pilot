import { describe, expect, it } from 'vitest';
import { searchTools, type DeferredTool } from '../../src/agent/toolSearch.js';
import { toolSearchTool } from '../../src/tools/toolSearch.js';

const DEFERRED: DeferredTool[] = [
  { name: 'github_create_issue', description: '在 GitHub 创建 issue', inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'issue 标题' } } } },
  { name: 'github_search_repos', description: '搜索 GitHub 仓库', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'web_fetch', description: '抓取网页正文', inputSchema: { type: 'object' } },
];

describe('searchTools', () => {
  it('按关键词命中相关工具', () => {
    const hits = searchTools(DEFERRED, 'github issue');
    expect(hits.map((h) => h.name)).toContain('github_create_issue');
  });

  it('schema 属性名参与检索', () => {
    const hits = searchTools(DEFERRED, '标题');
    expect(hits.map((h) => h.name)).toContain('github_create_issue');
  });

  it('空 query 返回空', () => {
    expect(searchTools(DEFERRED, '')).toEqual([]);
  });

  it('无匹配返回空', () => {
    expect(searchTools(DEFERRED, 'zzzzzz')).toEqual([]);
  });
});

describe('tool_search 工具', () => {
  it('命中后调用 load 并返回工具名', async () => {
    const loaded: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      toolSearch: { deferred: DEFERRED, load: (names: string[]) => loaded.push(...names) },
    };
    const r = await toolSearchTool.execute({ query: 'github' }, ctx);
    expect(r.isError).toBe(false);
    expect(loaded.length).toBeGreaterThan(0);
    expect(r.content).toContain('已加载');
  });

  it('无 deferred 时提示无外部工具', async () => {
    const r = await toolSearchTool.execute({ query: 'x' }, { cwd: process.cwd() });
    expect(r.content).toContain('没有可搜索的外部工具');
  });

  it('无匹配时不调用 load', async () => {
    const loaded: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      toolSearch: { deferred: DEFERRED, load: (n: string[]) => loaded.push(...n) },
    };
    const r = await toolSearchTool.execute({ query: 'zzzzzz' }, ctx);
    expect(loaded).toEqual([]);
    expect(r.content).toContain('没有找到');
  });
});

describe('tool_search 描述截断', () => {
  it('超长描述截断到 200 字符 + 截断标记；短描述原样', async () => {
    const long = 'x'.repeat(5000);
    const deferred = [
      { name: 'mcp__r__big', description: long, inputSchema: { type: 'object' } },
      { name: 'mcp__r__small', description: 'small desc', inputSchema: { type: 'object' } },
    ];
    const ctx = { cwd: process.cwd(), toolSearch: { deferred, load: () => {} } };
    const r = await toolSearchTool.execute({ query: 'big small' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).not.toContain(long);
    expect(r.content).toContain('…（截断，全文见加载后的工具 schema）');
    expect(r.content).toContain('small desc');
  });

  it('截断边界：刚好 200 字符的描述不截断，201 字符截断', async () => {
    const exact200 = 'a'.repeat(200);
    const over200 = 'b'.repeat(201);
    const deferred = [
      { name: 'exact', description: exact200, inputSchema: { type: 'object' } },
      { name: 'over', description: over200, inputSchema: { type: 'object' } },
    ];
    const ctx = { cwd: process.cwd(), toolSearch: { deferred, load: () => {} } };
    const r = await toolSearchTool.execute({ query: 'exact over' }, ctx);
    expect(r.isError).toBe(false);
    // 200 字符：原样出现
    expect(r.content).toContain(exact200);
    // 201 字符：被截断，输出里不应出现完整 201 字符串，但应出现截断标记
    expect(r.content).not.toContain(over200);
    expect(r.content).toContain('…（截断，全文见加载后的工具 schema）');
  });

  it('limit 参数限制返回条数', async () => {
    const deferred = Array.from({ length: 5 }, (_, i) => ({
      name: `tool_${i}`,
      description: `desc ${i}`,
      inputSchema: { type: 'object' },
    }));
    const loaded: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      toolSearch: { deferred, load: (names: string[]) => loaded.push(...names) },
    };
    const r = await toolSearchTool.execute({ query: 'tool', limit: 2 }, ctx);
    expect(r.isError).toBe(false);
    expect(loaded).toHaveLength(2);
    expect(r.content).toContain('已加载 2 个工具');
  });

  it('未传 limit 时默认 8 条', async () => {
    const deferred = Array.from({ length: 5 }, (_, i) => ({
      name: `t${i}`,
      description: `d${i}`,
      inputSchema: { type: 'object' },
    }));
    const loaded: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      toolSearch: { deferred, load: (names: string[]) => loaded.push(...names) },
    };
    const r = await toolSearchTool.execute({ query: 't' }, ctx);
    expect(r.isError).toBe(false);
    expect(loaded).toHaveLength(5);
    expect(r.content).toContain('已加载 5 个工具');
  });

});
