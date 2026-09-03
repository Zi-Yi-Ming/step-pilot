import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  encrypt,
  decrypt,
  saveOAuthToken,
  loadOAuthToken,
  deleteOAuthToken,
  listOAuthServers,
  OAuthToken,
} from '../../src/mcp/oauth.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
