import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  encrypt,
  decrypt,
  saveOAuthToken,
  loadOAuthToken,
  deleteOAuthToken,
  listOAuthServers,
  OAuthToken,
  isTokenExpired,
  exchangeRefreshToken,
} from '../../src/mcp/oauth.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

// runOAuthFlow 在顶层导入后内部闭包已固定，无法通过 vi.spyOn 替换 exchangeRefreshToken；
// 因此 refresh 分支测试改为动态导入，确保 mock 在 import 之前生效。
async function importRunOAuthFlow() {
  return import('../../src/mcp/oauth.js').then((m) => m.runOAuthFlow) as Promise<typeof import('../../src/mcp/oauth.js')['runOAuthFlow']>;
}

describe('oauth crypto', () => {
  it('encrypt/decrypt 往返一致', () => {
    const raw = JSON.stringify({ access_token: 'secret', scope: 'read' });
    const encrypted = encrypt(raw);
    expect(encrypted).not.toBe(raw);
    expect(encrypted.split(':')).toHaveLength(3);
    expect(decrypt(encrypted)).toBe(raw);
  });

  it('decrypt 坏格式抛错', () => {
    expect(() => decrypt('bad-format')).toThrow('Invalid encrypted format');
  });

  it('不同明文产生不同密文（随机 IV）', () => {
    const a = encrypt('{"token":"a"}');
    const b = encrypt('{"token":"b"}');
    expect(a).not.toBe(b);
  });
});

describe('oauth token store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step-oauth-'));

  beforeEach(() => {
    for (const name of listOAuthServers()) {
      deleteOAuthToken(name);
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('空 store 返回空', () => {
    expect(loadOAuthToken('server')).toBeUndefined();
    expect(listOAuthServers()).toEqual([]);
  });

  it('save/load/delete 生命周期', () => {
    const token: OAuthToken = {
      access_token: 'tok-123',
      token_type: 'Bearer',
      expires_in: 3600,
      obtainedAt: Date.now(),
    };
    saveOAuthToken('server', token);
    const loaded = loadOAuthToken('server');
    expect(loaded?.access_token).toBe('tok-123');
    expect(loaded?.token_type).toBe('Bearer');
    expect(listOAuthServers()).toEqual(['server']);

    deleteOAuthToken('server');
    expect(loadOAuthToken('server')).toBeUndefined();
    expect(listOAuthServers()).toEqual([]);
  });

  it('覆盖已有 token', () => {
    saveOAuthToken('server', { access_token: 'v1', obtainedAt: 1 } as OAuthToken);
    saveOAuthToken('server', { access_token: 'v2', obtainedAt: 2 } as OAuthToken);
    expect(loadOAuthToken('server')?.access_token).toBe('v2');
  });
});

describe('runOAuthFlow e2e', () => {
  let tokenServer: http.Server;
  let tokenPort: number;
  const openBrowserCalls: string[] = [];

  beforeEach(() => {
    openBrowserCalls.length = 0;
    for (const name of listOAuthServers()) {
      deleteOAuthToken(name);
    }
  });

  afterEach(() => {
    if (tokenServer) {
      tokenServer.close();
      tokenServer = undefined as unknown as http.Server;
    }
  });

  function startMockTokenServer(): void {
    tokenServer = http.createServer((req, res) => {
      if (req.url === '/oauth/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          if (params.get('grant_type') !== 'authorization_code') {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'mock-access-token',
              token_type: 'Bearer',
              expires_in: 3600,
              refresh_token: 'mock-refresh-token',
              scope: 'read write',
            }),
          );
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    tokenServer.listen(0, '127.0.0.1', () => {
      tokenPort = (tokenServer.address() as { port: number }).port;
    });
  }

  async function waitForTokenServer(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (tokenServer.listening) return resolve();
      tokenServer.on('listening', () => resolve());
    });
  }

  it('无 stored token → 打开浏览器 → callback → 换 token → 落盘 → 返回带 Authorization 的配置', async () => {
    startMockTokenServer();
    await waitForTokenServer();

    const tokenUrl = `http://127.0.0.1:${tokenPort}/oauth/token`;
    const runOAuthFlow = await importRunOAuthFlow();
    const result = await runOAuthFlow(
      'test-server',
      {
        url: 'https://example.com/mcp',
        headers: { 'X-Custom': 'keep' },
        auth: {
          type: 'oauth',
          authorizationUrl: 'https://provider.com/oauth/authorize',
          tokenUrl,
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          scopes: ['read', 'write'],
        },
      },
      {
        openBrowser: (url: string) => openBrowserCalls.push(url),
        startLocalCallbackServer: () => Promise.resolve('mock-auth-code'),
      },
    );

    // 浏览器被调用一次，且授权 URL 参数正确
    expect(openBrowserCalls).toHaveLength(1);
    const authUrl = new URL(openBrowserCalls[0]);
    expect(authUrl.toString()).toContain('https://provider.com/oauth/authorize');
    expect(authUrl.searchParams.get('client_id')).toBe('test-client-id');
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:18923/callback');
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('scope')).toBe('read write');

    // token 已加密落盘
    const saved = loadOAuthToken('test-server');
    expect(saved).toBeDefined();
    expect(saved?.access_token).toBe('mock-access-token');
    expect(saved?.token_type).toBe('Bearer');
    expect(saved?.refresh_token).toBe('mock-refresh-token');

    // 返回的配置合并了 Authorization header，且保留原有 headers
    expect(result.headers).toEqual({
      'X-Custom': 'keep',
      Authorization: 'Bearer mock-access-token',
    });
  });

  it('已有 stored token → 跳过浏览器/callback，直接复用 token', async () => {
    saveOAuthToken('test-server', {
      access_token: 'existing-token',
      token_type: 'Bearer',
      expires_in: 3600,
      obtainedAt: Date.now(),
    });

    const runOAuthFlow = await importRunOAuthFlow();
    const result = await runOAuthFlow(
      'test-server',
      {
        url: 'https://example.com/mcp',
        auth: {
          type: 'oauth',
          authorizationUrl: 'https://provider.com/oauth/authorize',
          tokenUrl: 'http://localhost:9999/token',
          clientId: 'test-client-id',
        },
      },
      {
        openBrowser: () => {
          throw new Error('openBrowser should not be called when token exists');
        },
        startLocalCallbackServer: () => {
          throw new Error('startLocalCallbackServer should not be called when token exists');
        },
      },
    );

    expect(openBrowserCalls).toHaveLength(0);
    expect(result.headers?.Authorization).toBe('Bearer existing-token');
  });

  it('callback 返回 error → 抛错', async () => {
    const runOAuthFlow = await importRunOAuthFlow();
    const err = await runOAuthFlow(
      'test-server',
      {
        url: 'https://example.com/mcp',
        auth: {
          type: 'oauth',
          authorizationUrl: 'https://provider.com/oauth/authorize',
          tokenUrl: 'http://localhost:9999/token',
          clientId: 'test-client-id',
        },
      },
      {
        openBrowser: () => {},
        startLocalCallbackServer: () => Promise.reject(new Error('OAuth authorization failed: access_denied')),
      },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('access_denied');
  });

  it('token endpoint 返回 400 → 抛错', async () => {
    startMockTokenServer();
    await waitForTokenServer();

    // 临时把 token endpoint 改成 400
    const badTokenServer = http.createServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
    });
    await new Promise<void>((resolve) => badTokenServer.listen(0, '127.0.0.1', () => resolve()));
    const badPort = (badTokenServer.address() as { port: number }).port;

    const runOAuthFlow = await importRunOAuthFlow();
    const err = await runOAuthFlow(
      'test-server',
      {
        url: 'https://example.com/mcp',
        auth: {
          type: 'oauth',
          authorizationUrl: 'https://provider.com/oauth/authorize',
          tokenUrl: `http://127.0.0.1:${badPort}/token`,
          clientId: 'test-client-id',
        },
      },
      {
        openBrowser: () => {},
        startLocalCallbackServer: () => Promise.resolve('mock-code'),
      },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('400');
    badTokenServer.close();
  });

  it('callback missing code → 抛错', async () => {
    const runOAuthFlow = await importRunOAuthFlow();
    const err = await runOAuthFlow(
      'test-server',
      {
        url: 'https://example.com/mcp',
        auth: {
          type: 'oauth',
          authorizationUrl: 'https://provider.com/oauth/authorize',
          tokenUrl: 'http://localhost:9999/token',
          clientId: 'test-client-id',
        },
      },
      {
        openBrowser: () => {},
        startLocalCallbackServer: () => Promise.reject(new Error('OAuth callback missing code')),
      },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('missing code');
  });
});

describe('isTokenExpired', () => {
  it('未过期返回 false', () => {
    const token: OAuthToken = { access_token: 't', obtainedAt: Date.now(), expires_in: 3600 };
    expect(isTokenExpired(token)).toBe(false);
  });

  it('已过期返回 true', () => {
    const token: OAuthToken = { access_token: 't', obtainedAt: Date.now() - 3600_000, expires_in: 1800 };
    expect(isTokenExpired(token)).toBe(true);
  });

  it('无 expiresAt 返回 false（保守放行）', () => {
    const token = { access_token: 't', obtainedAt: Date.now() } as OAuthToken;
    expect(isTokenExpired(token)).toBe(false);
  });

  it('skew 参数生效：未过期但接近过期时按 skew 判定', () => {
    // token 实际在 20 秒后过期：30s skew 判定为过期，10s skew 判定为未过期
    const token: OAuthToken = { access_token: 't', obtainedAt: Date.now(), expires_in: 20 };
    expect(isTokenExpired(token, 30_000)).toBe(true);
    expect(isTokenExpired(token, 10_000)).toBe(false);
  });
});

describe('exchangeRefreshToken', () => {
  let server: http.Server;
  let port: number;

  afterEach(() => {
    if (server) { server.close(); server = undefined as unknown as http.Server; }
  });

  it('成功刷新返回新 token', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/refresh' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          if (params.get('grant_type') === 'refresh_token' && params.get('refresh_token') === 'rt') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ access_token: 'new-t', token_type: 'Bearer', expires_in: 7200, refresh_token: 'new-rt' }));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'bad_request' }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as { port: number }).port;

    const token = await exchangeRefreshToken(
      { type: 'oauth', authorizationUrl: '', tokenUrl: `http://127.0.0.1:${port}/refresh`, clientId: 'cid' },
      'rt',
    );
    expect(token.access_token).toBe('new-t');
    expect(token.refresh_token).toBe('new-rt');
    expect(token.expires_in).toBe(7200);
  });

  it('400 抛错', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid_grant' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as { port: number }).port;

    const err = await exchangeRefreshToken(
      { type: 'oauth', authorizationUrl: '', tokenUrl: `http://127.0.0.1:${port}/refresh`, clientId: 'cid' },
      'bad-rt',
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('400');
  });
});

describe('runOAuthFlow refresh 分支', () => {
  let openBrowserCalls: string[];

  beforeEach(() => {
    openBrowserCalls = [];
    for (const name of listOAuthServers()) {
      deleteOAuthToken(name);
    }
  });

  it('token 未过期 → 直接复用，不调用浏览器/callback', async () => {
    saveOAuthToken('s1', { access_token: 'valid', token_type: 'Bearer', expires_in: 3600, obtainedAt: Date.now() });
    const runOAuthFlow = await importRunOAuthFlow();
    const result = await runOAuthFlow('s1', { url: 'https://example.com/mcp', auth: { type: 'oauth', authorizationUrl: 'https://p.com/a', tokenUrl: 'http://localhost:9999/t', clientId: 'cid' } });
    expect(result.headers?.Authorization).toBe('Bearer valid');
    expect(openBrowserCalls).toHaveLength(0);
  });

  it('token 已过期但有 refresh_token → refresh 成功，不调用浏览器/callback', async () => {
    saveOAuthToken('s2', { access_token: 'old', refresh_token: 'rt', expires_in: 3600, obtainedAt: Date.now() - 3600_000 });
    const runOAuthFlow = await importRunOAuthFlow();
    const result = await runOAuthFlow('s2', { url: 'https://example.com/mcp', auth: { type: 'oauth', authorizationUrl: 'https://p.com/a', tokenUrl: 'http://localhost:9999/t', clientId: 'cid' } }, {
      exchangeRefreshToken: async () => ({ access_token: 'refreshed-t', token_type: 'Bearer', expires_in: 7200, obtainedAt: Date.now() } as OAuthToken),
    });
    expect(result.headers?.Authorization).toBe('Bearer refreshed-t');
  });

  it('token 已过期且无 refresh_token → 走完整授权码流', async () => {
    saveOAuthToken('s3', { access_token: 'old', expires_in: 3600, obtainedAt: Date.now() - 3600_000 });
    const runOAuthFlow = await importRunOAuthFlow();
    const result = await runOAuthFlow('s3', { url: 'https://example.com/mcp', auth: { type: 'oauth', authorizationUrl: 'https://p.com/a', tokenUrl: 'http://localhost:9999/t', clientId: 'cid' } }, { 
      openBrowser: (url) => openBrowserCalls.push(url), 
      startLocalCallbackServer: () => Promise.resolve('code'),
      exchangeCodeForToken: async () => ({ access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600, obtainedAt: Date.now() } as OAuthToken),
    });
    expect(openBrowserCalls).toHaveLength(1);
    expect(result.headers?.Authorization).toBe('Bearer mock-access-token');
  });

  it('token 已过期，refresh 失败 → 清掉旧 token 并走完整授权码流', async () => {
    saveOAuthToken('s4', { access_token: 'old', refresh_token: 'bad-rt', expires_in: 3600, obtainedAt: Date.now() - 3600_000 });
    const runOAuthFlow = await importRunOAuthFlow();
    const result = await runOAuthFlow('s4', { url: 'https://example.com/mcp', auth: { type: 'oauth', authorizationUrl: 'https://p.com/a', tokenUrl: 'http://localhost:9999/t', clientId: 'cid' } }, { 
      openBrowser: (url) => openBrowserCalls.push(url), 
      startLocalCallbackServer: () => Promise.resolve('code'),
      exchangeRefreshToken: async () => { throw new Error('refresh failed'); },
      exchangeCodeForToken: async () => ({ access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600, obtainedAt: Date.now() } as OAuthToken),
    });
    expect(openBrowserCalls).toHaveLength(1);
    expect(result.headers?.Authorization).toBe('Bearer mock-access-token');
    // 旧 token 已被清除，且新 token 已落盘
    expect(loadOAuthToken('s4')?.access_token).toBe('mock-access-token');
  });
});
