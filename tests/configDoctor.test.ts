import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctorConfig } from '../src/config/doctor.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-doctor-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeToml(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('runDoctorConfig', () => {
  it('有效配置 → code 0 + ok', async () => {
    const p = writeToml('ok.toml', 'provider = "stepfun"\nmodel = "step-3.7-flash"\nlanguage = "zh"\n');
    const res = await runDoctorConfig(p);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('ok:');
    expect(res.stdout).not.toContain('warn:');
  });

  it('空文件（合法空表）→ code 0', async () => {
    const p = writeToml('empty.toml', '');
    const res = await runDoctorConfig(p);
    expect(res.code).toBe(0);
  });

  it('未知顶层键 → code 0 + warn 点名', async () => {
    const p = writeToml('unknown.toml', 'default_yolo = true\n');
    const res = await runDoctorConfig(p);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('warn:');
    expect(res.stdout).toContain('default_yolo');
  });

  it('TOML 语法错误 → code 1', async () => {
    const p = writeToml('bad.toml', 'provider = "stepfun"\n[unclosed\n');
    const res = await runDoctorConfig(p);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('TOML 解析失败');
  });

  it('文件不存在 → code 1', async () => {
    const res = await runDoctorConfig(join(dir, 'nope.toml'));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('配置文件不存在');
  });

  it('thinking budget 余量不足 → code 1（复用 loadConfig 抛错路径）', async () => {
    const p = writeToml('thinking.toml', '[thinking]\nenabled = true\nbudget_tokens = 65536\n');
    const res = await runDoctorConfig(p);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('budget_tokens');
  });

  it('thinking default_level 未命中档位 → code 1', async () => {
    const p = writeToml('level.toml', '[thinking]\ndefault_level = "ultra"\n');
    const res = await runDoctorConfig(p);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('default_level');
  });

  it('非法渠道 type → code 0 + warn', async () => {
    const p = writeToml('provider.toml', '[providers.foo]\ntype = "gemini"\n');
    const res = await runDoctorConfig(p);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('providers.foo');
  });

  it('hooks 非法 event → code 0 + warn', async () => {
    const p = writeToml('hooks.toml', '[[hooks]]\nevent = "PreTool"\ncommand = "echo hi"\n');
    const res = await runDoctorConfig(p);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('event');
  });

  it('mcp.json 存在且配置合法时展示 callTimeoutMs 生效值', async () => {
    const tomlPath = writeToml('config.toml', 'provider = "stepfun"\nmodel = "step-3.7-flash"\n');
    const dir = dirname(tomlPath);
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'npx', callTimeoutMs: 12345 } } }), 'utf8');
    const res = await runDoctorConfig(tomlPath);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('mcp server "github" 配置合法');
    expect(res.stdout).toContain('callTimeoutMs = 12345ms');
    expect(res.stdout).toContain('单次工具调用超时');
  });

  it('mcp.json 存在但未配置 callTimeoutMs 时不展示超时信息', async () => {
    const tomlPath = writeToml('config.toml', 'provider = "stepfun"\nmodel = "step-3.7-flash"\n');
    const dir = dirname(tomlPath);
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'npx' } } }), 'utf8');
    const res = await runDoctorConfig(tomlPath);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('mcp server "github" 配置合法');
    expect(res.stdout).not.toContain('callTimeoutMs');
  });
});
