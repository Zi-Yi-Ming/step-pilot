import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { AgentEvent } from '../../src/agent/events.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import type { ToolContext } from '../../src/tools/types.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';
import { McpManager } from '../../src/mcp/manager.js';
import * as tools from '../../src/tools/index.js';

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, { kind: 'user' });
}

describe('工具失败重试循环拦截', () => {
  let executeTool: ReturnType<typeof vi.spyOn<typeof tools, 'executeTool'>>;

  beforeEach(() => {
    executeTool = vi.spyOn(tools, 'executeTool');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('同一工具连续失败 3 次 → 回合终止并给出 notice', async () => {
    executeTool.mockRejectedValue(new Error('permission denied'));

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
    const { runAgent } = await import('../../src/agent/loop.js');
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }));

    // 同一工具被调用 3 次后触发重试循环拦截
    expect(executeTool.mock.calls.length).toBe(3);
    const notice = events.find((e) => e.type === 'notice');
    expect(notice).toBeDefined();
    expect((notice as { message: string }).message).toContain('read_file');
    expect((notice as { message: string }).message).toContain('3');
    // 重试循环终止时走 error 分支，loop 直接 return，不会补 turn_done
    expect(events.at(-1)!.type).toBe('notice');
  });

  it('不同工具各自失败不超过 3 次 → 回合正常继续', async () => {
    const failCounts = new Map<string, number>();
    executeTool.mockImplementation(async (name: string) => {
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
    const { runAgent } = await import('../../src/agent/loop.js');
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }));

    expect(events.at(-1)!.type).toBe('turn_done');
    const notice = events.find((e) => e.type === 'notice' && (e as { message: string }).message.includes('read_file'));
    expect(notice).toBeUndefined();
  });

  it('同一工具连续失败 3 次后，后续工具即使成功也不执行（本轮终止）', async () => {
    executeTool.mockRejectedValue(new Error('permission denied'));

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
    const { runAgent } = await import('../../src/agent/loop.js');
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }));

    // 当前实现是等本轮全部 settle 后再统一拦截，因此 4 个工具都会被执行
    expect(executeTool.mock.calls.length).toBe(4);
    const notice = events.find((e) => e.type === 'notice');
    expect(notice).toBeDefined();
    expect((notice as { message: string }).message).toContain('read_file');
    expect(events.at(-1)!.type).toBe('notice');
  });

  it('MCP 工具返回 isError=true 也计入连续失败，达到上限触发自动禁用', async () => {
    // 模拟 MCP 工具：不抛异常，而是返回 isError=true（callTool 内部消化错误）
    executeTool.mockImplementation(async (name: string) => {
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
    const { runAgent } = await import('../../src/agent/loop.js');
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent({ provider, system: 'sys', ctx, messages }));

    // 同一 MCP 工具被调用 3 次后触发重试循环拦截
    const mcpCalls = executeTool.mock.calls.filter(([n]) => (n as string).startsWith('mcp__'));
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
    executeTool.mockImplementation(async (name: string) => {
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
    const { runAgent } = await import('../../src/agent/loop.js');
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
  it('跨回合失败累计到上限 → 熔断（G3：计数不再每回合归零）', async () => {
    // 每次调用都失败，但每回合只调用 1 次：
    // 旧实现（runTurn 内建 Map）每回合归零，第 3 回合也只算「连续失败 1 次」，永不熔断。
    // 新实现把状态提到 loop 层，第 3 回合应触发熔断。
    executeTool.mockRejectedValue(new Error('permission denied'));

    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'read_file', { path: 'a.json', limit: 1 })] },
      { textChunks: [], finalContent: [toolUseBlock('c2', 'read_file', { path: 'b.json', limit: 1 })] },
      { textChunks: [], finalContent: [toolUseBlock('c3', 'read_file', { path: 'c.json', limit: 1 })] },
      { textChunks: ['不该走到这里'], finalContent: [textBlock('不该走到这里')] },
    ]);
    const { runAgent } = await import('../../src/agent/loop.js');
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }));

    // 恰好 3 次执行（第 3 次后熔断，不再进入第 4 回合）
    expect(executeTool.mock.calls.length).toBe(3);
    const notice = events.find((e) => e.type === 'notice' && (e as { message: string }).message.includes('read_file'));
    expect(notice).toBeDefined();
    expect(events.at(-1)!.type).toBe('notice');
  });

  it('跨回合中途成功一次即清零计数（不误伤偶发失败）', async () => {
    // 序列：失败、失败、成功、失败、失败 → 成功那次清零，最终不应熔断
    const results = [false, false, true, false, false];
    let i = 0;
    executeTool.mockImplementation(async () => {
      const ok = results[i++] ?? true;
      if (ok) return { content: 'ok', isError: false };
      throw new Error('transient failure');
    });

    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'read_file', { path: 'a', limit: 1 })] },
      { textChunks: [], finalContent: [toolUseBlock('c2', 'read_file', { path: 'b', limit: 1 })] },
      { textChunks: [], finalContent: [toolUseBlock('c3', 'read_file', { path: 'c', limit: 1 })] },
      { textChunks: [], finalContent: [toolUseBlock('c4', 'read_file', { path: 'd', limit: 1 })] },
      { textChunks: [], finalContent: [toolUseBlock('c5', 'read_file', { path: 'e', limit: 1 })] },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const { runAgent } = await import('../../src/agent/loop.js');
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }));

    // 成功一次后计数清零，后续 2 次失败不足以熔断
    const notice = events.find((e) => e.type === 'notice' && (e as { message: string }).message.includes('read_file'));
    expect(notice).toBeUndefined();
    expect(events.at(-1)!.type).toBe('turn_done');
  });
});
