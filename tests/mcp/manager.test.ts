import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  fnv1aHex,
  MAX_TOOL_NAME_LEN,
  McpManager,
  qualifyMcpToolName,
  type McpServerConfig,
} from '../../src/mcp/manager.js';
import { runOAuthFlow } from '../../src/mcp/oauth.js';

describe('qualifyMcpToolName', () => {
  it('生成 mcp__server__tool 命名', () => {
    expect(qualifyMcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
  });

  it('非法字符 sanitize', () => {
    expect(qualifyMcpToolName('my-server', 'do.thing')).toBe('mcp__my-server__do_thing');
  });

  it('64 字符内不截断', () => {
    const name = qualifyMcpToolName('a'.repeat(20), 'b'.repeat(30));
    expect(name).toBe(`mcp__${'a'.repeat(20)}__${'b'.repeat(30)}`);
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LEN);
  });

  it('超 64 字符截断：总长恰为 64，尾部为 _ + 8 字符哈希', () => {
    const name = qualifyMcpToolName('s'.repeat(40), 't'.repeat(40));
    expect(name.length).toBe(MAX_TOOL_NAME_LEN);
    expect(name).toMatch(/^mcp__s+.*_[0-9a-f]{8}$/);
    // 前缀保留截断前完整名的前 55 字符
    const full = `mcp__${'s'.repeat(40)}__${'t'.repeat(40)}`;
    expect(name.startsWith(full.slice(0, MAX_TOOL_NAME_LEN - 9))).toBe(true);
  });

  it('哈希后缀稳定：同名多次生成结果一致', () => {
    const a = qualifyMcpToolName('x'.repeat(40), 'y'.repeat(40));
    const b = qualifyMcpToolName('x'.repeat(40), 'y'.repeat(40));
    expect(a).toBe(b);
  });

  it('不同长名不撞：截断前缀相同时哈希后缀区分', () => {
    // 两个 tool 名前 55 字符相同、之后不同 → 截断后靠前缀无法区分，靠哈希后缀区分
    const a = qualifyMcpToolName('s'.repeat(30), `${'t'.repeat(30)}_aaa`);
    const b = qualifyMcpToolName('s'.repeat(30), `${'t'.repeat(30)}_bbb`);
    expect(a.length).toBe(MAX_TOOL_NAME_LEN);
    expect(b.length).toBe(MAX_TOOL_NAME_LEN);
    expect(a).not.toBe(b);
    // 哈希后缀确实来自截断前的完整名（FNV-1a）
    expect(a.endsWith(`_${fnv1aHex(`mcp__${'s'.repeat(30)}__${'t'.repeat(30)}_aaa`)}`)).toBe(true);
  });
});

/** 假 MCP manager：覆盖底层握手，不真起子进程/不发真请求。behavior 以 config.command ?? config.url 为 key。 */
class FakeManager extends McpManager {
  behavior: Record<string, 'ok' | 'fail' | 'hang'> = {};
  calls: string[] = [];

  protected override async connectAndListTools(
    _client: Client,
    config: McpServerConfig,
  ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const key = config.command ?? config.url ?? '';
    this.calls.push(key);
    const b = this.behavior[key] ?? 'ok';
    if (b === 'fail') throw new Error('spawn failed\nsecond line');
    if (b === 'hang') await new Promise((r) => setTimeout(r, 200));
    return [
      { name: 'echo', description: 'echo tool', inputSchema: { type: 'object' } },
      { name: 'ping' },
    ];
  }
}

const cfg = (command: string, extra?: Partial<McpServerConfig>): McpServerConfig => ({ command, ...extra });

describe('McpManager 并行连接', () => {
  it('connectAll 并行发起：全部 server 先进入 pending', async () => {
    const m = new FakeManager();
    m.behavior = { a: 'hang', b: 'hang' };
    const done = m.connectAll({ a: cfg('a'), b: cfg('b') });
    // connectAll 同步执行到首个 await 之前，两个 server 都已标记 pending
    expect(m.statuses().map((s) => s.status)).toEqual(['pending', 'pending']);
    await done;
    expect(m.statuses().map((s) => s.status)).toEqual(['connected', 'connected']);
  });

  it('单点失败隔离：失败 server 记 failed，其余照常 connected', async () => {
    const m = new FakeManager();
    m.behavior = { bad: 'fail' };
    await m.connectAll({ good1: cfg('good1'), bad: cfg('bad'), good2: cfg('good2') });
    const byName = new Map(m.statuses().map((s) => [s.name, s]));
    expect(byName.get('good1')?.status).toBe('connected');
    expect(byName.get('good2')?.status).toBe('connected');
    expect(byName.get('bad')?.status).toBe('failed');
    // 错误摘要压成单行
    expect(byName.get('bad')?.error).toBe('spawn failed second line');
    // 成功 server 的工具可用，失败 server 无工具
    expect(m.toolsOf('good1').map((x) => x.qualifiedName)).toEqual(['mcp__good1__echo', 'mcp__good1__ping']);
    expect(m.toolsOf('bad')).toEqual([]);
    expect(m.allTools()).toHaveLength(4);
  });

  it('connect 失败不抛出，返回 false', async () => {
    const m = new FakeManager();
    m.behavior = { bad: 'fail' };
    expect(await m.connect('bad', cfg('bad'))).toBe(false);
    expect(await m.connect('ok', cfg('ok'))).toBe(true);
  });

  it('onConnected 增量回调：只对连接成功的 server 触发', async () => {
    const m = new FakeManager();
    m.behavior = { bad: 'fail' };
    const connected: string[] = [];
    await m.connectAll({ a: cfg('a'), bad: cfg('bad'), b: cfg('b') }, (name) => connected.push(name));
    expect([...connected].sort()).toEqual(['a', 'b']);
  });

  it('startupTimeoutMs 覆盖默认超时：慢 server 超时记 failed', async () => {
    const m = new FakeManager();
    m.behavior = { slow: 'hang' }; // 假 server 握手 200ms
    const ok = await m.connect('slow', cfg('slow', { startupTimeoutMs: 20 }));
    expect(ok).toBe(false);
    const s = m.statuses()[0]!;
    expect(s.status).toBe('failed');
    expect(s.error).toContain('超时');
    // 慢 server 的迟到 resolve 不会改写 failed 状态，也不会补登工具
    await new Promise((r) => setTimeout(r, 250));
    expect(m.statuses()[0]!.status).toBe('failed');
    expect(m.toolsOf('slow')).toEqual([]);
  });

  it('默认启动超时为 30 秒', () => {
    expect(DEFAULT_STARTUP_TIMEOUT_MS).toBe(30_000);
  });

  it('enabled:false 记 disabled，不发起连接', async () => {
    const m = new FakeManager();
    const ok = await m.connect('off', cfg('off', { enabled: false }));
    expect(ok).toBe(false);
    expect(m.statuses()[0]).toEqual({ name: 'off', status: 'disabled', toolCount: 0 });
    expect(m.calls).toEqual([]);
  });

  it('statuses 暴露 connected 工具数与 transport 形态（headers 只显示已配置不显值）', async () => {
    const m = new FakeManager();
    await m.connect('a', cfg('a'));
    expect(m.statuses()[0]).toEqual({ name: 'a', status: 'connected', toolCount: 2, transport: 'stdio: a' });
    await m.connect('r', { url: 'https://x.example/mcp', headers: { Authorization: 'Bearer secret' } });
    const st = m.statuses().find((s) => s.name === 'r')!;
    expect(st).toEqual({
      name: 'r',
      status: 'connected',
      toolCount: 2,
      transport: 'http: https://x.example/mcp (+headers)',
    });
    // header 值不得进状态展示
    expect(JSON.stringify(st)).not.toContain('secret');
  });

  it('closeAll 清空已连接 server：工具登记随连接一起移除', async () => {
    const m = new FakeManager();
    await m.connectAll({ a: cfg('a'), b: cfg('b') });
    expect(m.allTools()).toHaveLength(4);
    await m.closeAll();
    expect(m.allTools()).toEqual([]);
    expect(m.toolsOf('a')).toEqual([]);
    // 幂等：重复关闭不抛错
    await m.closeAll();
  });
});

describe('server 配置校验与 http 类型', () => {
  it('validateServerConfig：command/url 互斥，必填其一，url 必须合法绝对地址', async () => {
    const { validateServerConfig } = await import('../../src/mcp/manager.js');
    expect(validateServerConfig({ command: 'npx' })).toBeNull();
    expect(validateServerConfig({ url: 'https://example.com/mcp' })).toBeNull();
    expect(validateServerConfig({})).toContain('二者必填其一');
    expect(validateServerConfig({ command: 'npx', url: 'https://example.com/mcp' })).toContain('二选一');
    expect(validateServerConfig({ url: 'not-a-url' })).toContain('不是合法的绝对地址');
    expect(validateServerConfig({ url: '' })).toContain('二者必填其一');
  });

  it('坏配置 connect 直接 failed，不进入握手（错误进 /mcp 面板状态）', async () => {
    const m = new FakeManager();
    const ok = await m.connect('bad', cfg('' as string));
    expect(ok).toBe(false);
    expect(m.calls).toEqual([]);
    expect(m.statuses()[0]).toMatchObject({ name: 'bad', status: 'failed' });
    expect(m.statuses()[0]!.error).toContain('二者必填其一');
  });

  it('command 与 url 同时给的配置同样 failed 且不握手', async () => {
    const m = new FakeManager();
    const ok = await m.connect('both', { command: 'npx', url: 'https://example.com/mcp' });
    expect(ok).toBe(false);
    expect(m.calls).toEqual([]);
    expect(m.statuses()[0]!.error).toContain('二选一');
  });

  it('url 配置走 http 分支进入握手（FakeManager 按 url 记录调用）', async () => {
    const m = new FakeManager();
    const ok = await m.connect('remote', { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } });
    expect(ok).toBe(true);
    expect(m.calls).toEqual(['https://example.com/mcp']);
    expect(m.statuses()[0]).toMatchObject({ name: 'remote', status: 'connected', toolCount: 2 });
  });
});

describe('callTool 超时', () => {
  it('挂起的调用在 callTimeoutMs 后转 isError 回灌，不无限等待', async () => {
    class HangingManager extends FakeManager {
      protected override async connectAndListTools(
        _client: Client,
        config: McpServerConfig,
      ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
        await super.connectAndListTools(_client, config);
        // 记录 client 供 callTool 打桩
        return [{ name: 'hang', description: 'hangs on call', inputSchema: { type: 'object' } }];
      }
    }
    const m = new HangingManager();
    await m.connect('slow', { command: 'slow-server', callTimeoutMs: 50 });
    // 打桩：让底层 client.callTool 永远挂起
    const server = [...m['servers'].values()][0]!;
    server.client.callTool = () => new Promise(() => {});
    const t0 = Date.now();
    const r = await m.callTool('mcp__slow__hang', {});
    const elapsed = Date.now() - t0;
    expect(r.isError).toBe(true);
    expect(r.content).toContain('调用超时');
    expect(elapsed).toBeLessThan(3000);
  });

  it('正常调用不受超时影响', async () => {
    const m = new FakeManager();
    await m.connect('ok', { command: 'ok-server' });
    const server = [...m['servers'].values()][0]!;
    server.client.callTool = (async () => ({
      content: [{ type: 'text', text: 'pong' }],
      isError: false,
    })) as never;
    const r = await m.callTool('mcp__ok__echo', {});
    expect(r.isError).toBe(false);
    expect(r.content).toBe('pong');
  });
});

describe('httpTransportOptions 重连策略配置化', () => {
  it('未配置重连字段时不出 reconnectionOptions（尊重 SDK 默认）', async () => {
    const { httpTransportOptions } = await import('../../src/mcp/manager.js');
    const o = httpTransportOptions({ url: 'https://x.example/mcp' });
    expect(o.reconnectionOptions).toBeUndefined();
    expect(o.requestInit.headers).toBeUndefined();
  });

  it('maxRetries / reconnectDelayMs 透传并 clamp 到合法区间', async () => {
    const { httpTransportOptions } = await import('../../src/mcp/manager.js');
    const o = httpTransportOptions({ url: 'https://x.example/mcp', maxRetries: 99, reconnectDelayMs: 10 });
    expect(o.reconnectionOptions).toBeDefined();
    expect(o.reconnectionOptions!.maxRetries).toBe(10); // 99 clamp 到 10
    expect(o.reconnectionOptions!.initialReconnectionDelay).toBe(100); // 10 clamp 到 100
    expect(o.reconnectionOptions!.maxReconnectionDelay).toBeGreaterThanOrEqual(30000);
  });

  it('headers 照常透传', async () => {
    const { httpTransportOptions } = await import('../../src/mcp/manager.js');
    const o = httpTransportOptions({ url: 'https://x.example/mcp', headers: { Authorization: 'Bearer t' } });
    expect(o.requestInit.headers).toEqual({ Authorization: 'Bearer t' });
  });
});

describe('OAuth 集成', () => {
  it('http + auth.type=oauth 时调用 runOAuthFlow 并注入 Authorization', async () => {
    const m = new FakeManager();
    const oauthModule = await import('../../src/mcp/oauth.js');
    const spy = vi.spyOn(oauthModule, 'runOAuthFlow').mockImplementation(async (name, config) => ({
      ...config,
      headers: { ...config.headers, Authorization: `Bearer oauth-token-${name}` },
    }));
    await m.connect('remote', {
      url: 'https://example.com/mcp',
      auth: { type: 'oauth', authorizationUrl: 'https://example.com/oauth/authorize', tokenUrl: 'https://example.com/oauth/token', clientId: 'cid' },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('remote', expect.objectContaining({ url: 'https://example.com/mcp' }));
    expect(m.statuses()[0]).toMatchObject({ status: 'connected' });
  });

  it('OAuth flow 失败时记 failed 状态', async () => {
    const m = new FakeManager();
    const oauthModule = await import('../../src/mcp/oauth.js');
    vi.spyOn(oauthModule, 'runOAuthFlow').mockRejectedValue(new Error('oauth denied'));
    const ok = await m.connect('bad', {
      url: 'https://example.com/mcp',
      auth: { type: 'oauth', authorizationUrl: 'https://example.com/oauth/authorize', tokenUrl: 'https://example.com/oauth/token', clientId: 'cid' },
    });
    expect(ok).toBe(false);
    expect(m.statuses()[0]).toMatchObject({ status: 'failed' });
    expect(m.statuses()[0]!.error).toContain('oauth denied');
  });

  it('非 oauth 配置不触发 runOAuthFlow', async () => {
    const m = new FakeManager();
    const oauthModule = await import('../../src/mcp/oauth.js');
    const spy = vi.spyOn(oauthModule, 'runOAuthFlow').mockClear();
    await m.connect('plain', { url: 'https://example.com/mcp' });
    expect(spy).not.toHaveBeenCalled();
  });
});
