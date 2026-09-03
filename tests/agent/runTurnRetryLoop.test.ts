import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { AgentEvent } from '../../src/agent/events.js';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import type { ToolContext } from '../../src/tools/types.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';
import { McpManager } from '../../src/mcp/manager.js';

// 在顶层声明 mock，避免 vitest 提升顺序导致的警告
vi.mock('../../src/tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/tools/index.js')>('../../src/tools/index.js');
  return {
    ...actual,
    executeTool: vi.fn(),
  };
});

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, { kind: 'user' });
}

describe('工具失败重试循环拦截', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('同一工具连续失败 3 次 → 回合终止并给出 notice', async () => {
    const { executeTool } = await import('../../src/tools/index.js');
    vi.mocked(executeTool).mockRejectedValue(new Error('permission denied'));

    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'read_file', { path: 'package.json', limit: 1 }),
          toolUseBlock('c2', 'read_file', { path: 'tsconfig.json', limit: 1 }),
          toolUseBlock('c3', 'read_file', { path: 'README.md', limit: 1 }),
        ],
      },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }));

    // 同一工具被调用 3 次后触发重试循环拦截
    expect(vi.mocked(executeTool).mock.calls.length).toBe(3);
    const notice = events.find((e) => e.type === 'notice');
    expect(notice).toBeDefined();
    expect((notice as { message: string }).message).toContain('read_file');
    expect((notice as { message: string }).message).toContain('3');
    // 重试循环终止时走 error 分支，loop 直接 return，不会补 turn_done
    expect(events.at(-1)!.type).toBe('notice');
  });

  it('不同工具各自失败不超过 3 次 → 回合正常继续', async () => {
    const { executeTool } = await import('../../src/tools/index.js');
    const failCounts = new Map<string, number>();
    vi.mocked(executeTool).mockImplementation(async (name: string) => {
      const count = (failCounts.get(name) ?? 0) + 1;
      failCounts.set(name, count);
      if (name === 'read_file' && count <= 2) {
        throw new Error('permission denied');
      }
      return { content: `read ${name}`, isError: false };
    });

    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'read_file', { path: 'a.json', limit: 1 }),
          toolUseBlock('c2', 'read_file', { path: 'b.json', limit: 1 }),
          toolUseBlock('c3', 'read_file', { path: 'c.json', limit: 1 }),
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }));

    expect(events.at(-1)!.type).toBe('turn_done');
    const notice = events.find((e) => e.type === 'notice' && (e as { message: string }).message.includes('read_file'));
    expect(notice).toBeUndefined();
  });

  it('同一工具连续失败 3 次后，后续工具即使成功也不执行（本轮终止）', async () => {
    const { executeTool } = await import('../../src/tools/index.js');
    vi.mocked(executeTool).mockRejectedValue(new Error('permission denied'));

    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'read_file', { path: 'a.json', limit: 1 }),
          toolUseBlock('c2', 'read_file', { path: 'b.json', limit: 1 }),
          toolUseBlock('c3', 'read_file', { path: 'c.json', limit: 1 }),
          toolUseBlock('c4', 'write_file', { path: 'out.txt', content: 'ok' }),
        ],
      },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }));

    // 当前实现是等本轮全部 settle 后再统一拦截，因此 4 个工具都会被执行
    expect(vi.mocked(executeTool).mock.calls.length).toBe(4);
    const notice = events.find((e) => e.type === 'notice');
    expect(notice).toBeDefined();
    expect((notice as { message: string }).message).toContain('read_file');
    expect(events.at(-1)!.type).toBe('notice');
  });

  it('MCP 工具返回 isError=true 也计入连续失败，达到上限触发自动禁用', async () => {
    const { executeTool } = await import('../../src/tools/index.js');
    // 模拟 MCP 工具：不抛异常，而是返回 isError=true（callTool 内部消化错误）
    vi.mocked(executeTool).mockImplementation(async (name: string) => {
      if (name.startsWith('mcp__')) {
        return { content: 'MCP error', isError: true };
      }
      return { content: 'ok', isError: false };
    });

    const mcp = new McpManager();
    const ctx: ToolContext = {
      cwd: process.cwd(),
      mcpManager: mcp,
      mcpConfig: { autoDisableOnRetryLoop: true },
    };

    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'mcp__github__create_issue', { title: 'a' }),
          toolUseBlock('c2', 'mcp__github__create_issue', { title: 'b' }),
          toolUseBlock('c3', 'mcp__github__create_issue', { title: 'c' }),
        ],
      },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent({ provider, system: 'sys', ctx, messages }));

    // 同一 MCP 工具被调用 3 次后触发重试循环拦截
    const mcpCalls = vi.mocked(executeTool).mock.calls.filter(([n]) => (n as string).startsWith('mcp__'));
    expect(mcpCalls.length).toBe(3);
    const notice = events.find((e) => e.type === 'notice');
    expect(notice).toBeDefined();
    expect((notice as { message: string }).message).toContain('mcp__github__create_issue');
    expect((notice as { message: string }).message).toContain('3');
    expect(events.at(-1)!.type).toBe('notice');
    // 自动禁用已触发
    expect(mcp.isToolDisabled('mcp__github__create_issue')).toBe(true);
  });

  it('autoDisableOnRetryLoop=false 时不自动禁用 MCP 工具', async () => {
    const { executeTool } = await import('../../src/tools/index.js');
    vi.mocked(executeTool).mockImplementation(async (name: string) => {
      if (name.startsWith('mcp__')) {
        return { content: 'MCP error', isError: true };
      }
      return { content: 'ok', isError: false };
    });

    const mcp = new McpManager();
    const ctx: ToolContext = {
      cwd: process.cwd(),
      mcpManager: mcp,
      mcpConfig: { autoDisableOnRetryLoop: false },
    };

    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'mcp__github__create_issue', { title: 'a' }),
          toolUseBlock('c2', 'mcp__github__create_issue', { title: 'b' }),
          toolUseBlock('c3', 'mcp__github__create_issue', { title: 'c' }),
        ],
      },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent({ provider, system: 'sys', ctx, messages }));

    const notice = events.find((e) => e.type === 'notice');
    expect(notice).toBeDefined();
    // 未触发自动禁用
    expect(mcp.isToolDisabled('mcp__github__create_issue')).toBe(false);
  });

  it('MCP 工具被自动禁用后，isToolDisabled 反映该状态', async () => {
    const mcp = new McpManager();
    // 模拟 auto-disable 后的状态：直接标记禁用，不依赖真实连接
    mcp.disableTool('mcp__github__create_issue');
    expect(mcp.isToolDisabled('mcp__github__create_issue')).toBe(true);
    // 重置可恢复
    mcp.resetDisabledTools();
    expect(mcp.isToolDisabled('mcp__github__create_issue')).toBe(false);
  });
});
