/**
 * MCP streamable http transport 的**真线协议**集成测试。
 *
 * 为什么必须有这一层：manager.test.ts 全是 mock（FakeManager 覆盖握手），
 * StreamableHTTPClientTransport → 真 HTTP → StreamableHTTPServerTransport 这条
 * 线协议路径从未被验证过——这是 0.1.5 发布时登记的最大未验证面。
 *
 * 做法：进程内用 SDK 的 server 端（McpServer + StreamableHTTPServerTransport）
 * 起一个真实的 http server（ephemeral 端口，无子进程），McpManager 走真实的
 * StreamableHTTPClientTransport 连接。覆盖：连接发现、工具调用、调用超时、
 * headers 鉴权（缺 token 401 / 带 token 连通）。
 */
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpManager } from '../../src/mcp/manager.js';

const TOKEN = 'test-token-123';

let baseUrl = '';
let child: ReturnType<typeof spawn> | undefined;

beforeAll(async () => {
  // server 逻辑在独立进程跑：与测试进程的 manager 完全隔离，线协议是真跨进程 HTTP。
  child = spawn(process.execPath, ['tests/mcp/fixtures/httpServer.cjs'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server boot timeout')), 15000);
    let buf = '';
    child!.stdout!.on('data', (c: Buffer) => {
      buf += c.toString();
      const m = buf.match(/PORT:(\d+)/);
      if (m !== null) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child!.stderr!.on('data', (c: Buffer) => process.stderr.write('[server] ' + c.toString()));
  });
  baseUrl = `http://127.0.0.1:${port}`;
}, 20000);

afterAll(() => {
  child?.kill();
});

describe('MCP streamable http 真线协议', () => {
  it('缺 token 连接失败（真 401），错误进状态表', { timeout: 15000 }, async () => {
    const m = new McpManager();
    const ok = await m.connect('authed', { url: baseUrl });
    expect(ok).toBe(false);
    const st = m.statuses()[0]!;
    expect(st.status).toBe('failed');
    expect(st.error).toBeTruthy();
  });

  it('带 token 连接：发现工具并调用成功（echo 回环）', { timeout: 15000 }, async () => {
    const m = new McpManager();
    const ok = await m.connect(
      'authed',
      { url: baseUrl, headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(ok).toBe(true);
    expect(m.statuses()[0]).toMatchObject({ status: 'connected', transport: `http: ${baseUrl} (+headers)` });
    // 工具被真实发现（服务端注册了 echo / slow 两个）
    const names = m.allTools().map((t) => t.toolName).sort();
    expect(names).toEqual(['echo', 'slow']);
    const r = await m.callTool('mcp__authed__echo', { message: 'hello integration' });
    expect(r.isError).toBe(false);
    expect(r.content).toBe('echo: hello integration');
    await m.closeAll();
  });

  it('callTimeoutMs 走真超时：slow 工具 500ms，50ms 预算 → isError', { timeout: 15000 }, async () => {
    const m = new McpManager();
    const ok = await m.connect(
      'authed',
      { url: baseUrl, headers: { Authorization: `Bearer ${TOKEN}` }, callTimeoutMs: 50 },
    );
    expect(ok).toBe(true);
    const r = await m.callTool('mcp__authed__slow', {});
    expect(r.isError).toBe(true);
    expect(r.content).toContain('调用超时');
    await m.closeAll();
  });

  it('充足预算下 slow 工具正常返回（超时路径不误伤慢而正常的工具）', { timeout: 15000 }, async () => {
    const m = new McpManager();
    await m.connect('authed', { url: baseUrl, headers: { Authorization: `Bearer ${TOKEN}` }, callTimeoutMs: 5000 });
    const r = await m.callTool('mcp__authed__slow', {});
    expect(r.isError).toBe(false);
    expect(r.content).toBe('finally done');
    await m.closeAll();
  });
});
