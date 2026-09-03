/**
 * MCP OAuth 客户端能力（client-side OAuth）。
 *
 * 0.1.7 最小闭环：
 * - 用户配置 auth.type = 'oauth' + authorizationUrl / tokenUrl / clientId
 * - connect 时检测无有效 token → 打开浏览器授权 → 本地 callback 收 code
 * - code 换 access_token → 加密持久化到 ~/.step-pilot/mcp-oauth.json
 * - 后续请求自动注入 Authorization: Bearer <token>
 *
 * 不做（留到后续版本）：
 * - refresh_token 自动刷新
 * - access_token 过期检测与重授权
 * - OAuth 2.0 PKCE
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

function getOAuthDir(): string {
  return join(homedir(), '.step-pilot');
}
function getOAuthFile(): string {
  return join(getOAuthDir(), 'mcp-oauth.json');
}
function getKeyFile(): string {
  return join(getOAuthDir(), '.oauth.key');
}

function getKey(): Buffer {
  if (existsSync(getKeyFile())) {
    return Buffer.from(readFileSync(getKeyFile(), 'utf8').trim(), 'hex');
  }
  const key = randomBytes(KEY_LENGTH);
  mkdirSync(getOAuthDir(), { recursive: true });
  writeFileSync(getKeyFile(), key.toString('hex'), { mode: 0o600 });
  return key;
}

export function encrypt(text: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(encrypted: string): string {
  const [ivHex, tagHex, dataHex] = encrypted.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Invalid encrypted format');
  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

/** 单条 token 记录。 */
export interface OAuthToken {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  obtainedAt: number;
  /** 绝对过期时间戳（毫秒）。由 obtainedAt + expires_in * 1000 计算，缺失 expires_in 时 undefined。 */
  expiresAt?: number;
}

/** 判断 token 是否已过期（含 skew 缓冲，默认提前 30 秒判定过期）。 */
export function isTokenExpired(token: OAuthToken, skewMs = 30_000): boolean {
  const expiresAt = token.expiresAt ?? (token.obtainedAt !== undefined && token.expires_in !== undefined
    ? token.obtainedAt + token.expires_in * 1000
    : undefined);
  if (expiresAt === undefined) return false;
  return Date.now() >= expiresAt - skewMs;
}

/** 用 refresh_token 换新的 access_token。 */
export async function exchangeRefreshToken(
  config: OAuthServerConfig,
  refreshToken: string,
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId ?? '',
  });
  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret);
  }
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token refresh failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };
  return {
    ...data,
    obtainedAt: Date.now(),
  };
}

/** mcp.json 里 server 级的 OAuth 配置。 */
export interface OAuthServerConfig {
  type: 'oauth';
  /** 授权端点（如 https://github.com/login/oauth/authorize）。 */
  authorizationUrl: string;
  /** token 端点（如 https://github.com/login/oauth/access_token）。 */
  tokenUrl: string;
  /** 请求的 scope 列表。 */
  scopes?: string[];
  /** OAuth client id。 */
  clientId?: string;
  /** OAuth client secret（ confidential client 必填）。 */
  clientSecret?: string;
  /** 回调地址（必须与 provider 端注册的一致）。缺省用本地固定端口。 */
  redirectUri?: string;
}

/** runOAuthFlow 需要的输入字段（避免循环导入 McpServerConfig）。 */
export interface OAuthFlowInput {
  url?: string;
  headers?: Record<string, string>;
  auth: OAuthServerConfig;
}

/** 打开系统浏览器（跨平台，不依赖 shell 注入）。 */
export function openBrowser(url: string): void {
  let cmd: string[];
  switch (platform()) {
    case 'win32':
      cmd = ['cmd', '/c', 'start', '', url];
      break;
    case 'darwin':
      cmd = ['open', url];
      break;
    default:
      cmd = ['xdg-open', url];
  }
  execFileSync(cmd[0], cmd.slice(1), { stdio: 'ignore' });
}

/** 启动本地 callback server，等待 OAuth provider 重定向回来。 */
export async function startLocalCallbackServer(port: number): Promise<string> {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
        if (reqUrl.pathname === '/callback') {
          const code = reqUrl.searchParams.get('code');
          const error = reqUrl.searchParams.get('error');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body>授权成功，可以关闭此窗口。</body></html>');
          server.close();
          if (error) return reject(new Error(`OAuth authorization failed: ${error}`));
          if (!code) return reject(new Error('OAuth callback missing code'));
          resolve(code);
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch {
        res.writeHead(400);
        res.end();
        server.close();
        reject(new Error('OAuth callback request malformed'));
      }
    });
    server.on('error', () => {
      server.close();
      reject(new Error(`OAuth callback port ${port} is in use`));
    });
    server.listen(port, '127.0.0.1');
  });
}

/** 用 authorization_code 换 access_token。 */
export async function exchangeCodeForToken(
  config: OAuthServerConfig,
  code: string,
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId ?? '',
  });
  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret);
  }
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token exchange failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };
  return {
    ...data,
    obtainedAt: Date.now(),
  };
}

/** 保存 server 级 token（加密覆盖）。 */
export function saveOAuthToken(serverName: string, token: OAuthToken): void {
  const data = loadAllTokens();
  // 计算 expiresAt（已有则保留，避免重复计算）
  const saved: OAuthToken = { ...token };
  if (saved.expiresAt === undefined && saved.expires_in !== undefined && saved.obtainedAt !== undefined) {
    saved.expiresAt = saved.obtainedAt + saved.expires_in * 1000;
  }
  data[serverName] = saved;
  writeFileSync(getOAuthFile(), encrypt(JSON.stringify(data, null, 2)), 'utf8');
}

/** 读取 server 级 token。 */
export function loadOAuthToken(serverName: string): OAuthToken | undefined {
  const data = loadAllTokens();
  return data[serverName];
}

/** 删除 server 级 token（吊销/重授权）。 */
export function deleteOAuthToken(serverName: string): void {
  const data = loadAllTokens();
  delete data[serverName];
  writeFileSync(getOAuthFile(), encrypt(JSON.stringify(data, null, 2)), 'utf8');
}

/** 列出已存储 token 的 server 名。 */
export function listOAuthServers(): string[] {
  const data = loadAllTokens();
  return Object.keys(data);
}

/** 跑完整 OAuth authorization code flow：无 token 时弹浏览器授权，已有 token 直接复用。 */
export async function runOAuthFlow(
  name: string,
  config: OAuthFlowInput,
  deps?: {
    openBrowser?: (url: string) => void;
    startLocalCallbackServer?: (port: number) => Promise<string>;
    exchangeCodeForToken?: typeof exchangeCodeForToken;
    exchangeRefreshToken?: typeof exchangeRefreshToken;
  },
): Promise<OAuthFlowInput> {
  // 已有 token：未过期直接复用；已过期但可 refresh → 刷新后复用；否则走完整授权码流
  const stored = loadOAuthToken(name);
  if (stored?.access_token) {
    if (!isTokenExpired(stored)) {
      return {
        ...config,
        headers: {
          ...config.headers,
          Authorization: `${stored.token_type ?? 'Bearer'} ${stored.access_token}`,
        },
      };
    }
    // token 过期，尝试 refresh
    if (stored.refresh_token) {
      try {
        const refreshed = await (deps?.exchangeRefreshToken ?? exchangeRefreshToken)(config.auth, stored.refresh_token);
        saveOAuthToken(name, refreshed);
        return {
          ...config,
          headers: {
            ...config.headers,
            Authorization: `${refreshed.token_type ?? 'Bearer'} ${refreshed.access_token}`,
          },
        };
      } catch {
        // refresh 失败，清掉旧 token，走完整授权码流
        deleteOAuthToken(name);
      }
    } else {
      // 过期且无 refresh_token，清掉旧 token 走完整授权码流
      deleteOAuthToken(name);
    }
  }

  // 无 token，走授权流程
  const redirectUri = config.auth.redirectUri || 'http://localhost:18923/callback';
  const redirectUrl = new URL(redirectUri);
  const port = redirectUrl.port ? Number(redirectUrl.port) : 18923;

  const callbackPromise = (deps?.startLocalCallbackServer ?? startLocalCallbackServer)(port);

  const authUrl = new URL(config.auth.authorizationUrl);
  authUrl.searchParams.set('client_id', config.auth.clientId ?? '');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  if (config.auth.scopes?.length) {
    authUrl.searchParams.set('scope', config.auth.scopes.join(' '));
  }

  (deps?.openBrowser ?? openBrowser)(authUrl.toString());
  const code = await callbackPromise;
  const token = await (deps?.exchangeCodeForToken ?? exchangeCodeForToken)(config.auth, code);
  saveOAuthToken(name, token);

  return {
    ...config,
    headers: {
      ...config.headers,
      Authorization: `${token.token_type ?? 'Bearer'} ${token.access_token}`,
    },
  };
}

function loadAllTokens(): Record<string, OAuthToken> {
  if (!existsSync(getOAuthFile())) return {};
  try {
    const encrypted = readFileSync(getOAuthFile(), 'utf8').trim();
    if (encrypted.length === 0) return {};
    return JSON.parse(decrypt(encrypted));
  } catch {
    return {};
  }
}
