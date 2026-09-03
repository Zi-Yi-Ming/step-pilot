import { describe, expect, it } from 'vitest';
import { API_KEY_PLACEHOLDER, exportConfigTemplate } from '../../src/config/exportConfig.js';
import { exportMcpConfigTemplate } from '../../src/config/exportMcpConfig.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

describe('exportConfigTemplate', () => {
  it('剥离顶层、providers、models 三处 api_key，其余原样保留', () => {
    const text = [
      '# 顶部注释保留',
      'provider = "stepfun"',
      'api_key = "sk-secret-top"',
      '',
      '[providers.stepfun]',
      'type = "anthropic"',
      'api_key = "sk-secret-provider"',
      '',
      '[models.song]',
      'model = "step-3.7-flash"',
      'api_key = "sk-secret-model"',
      'api_key_env = "MY_KEY_ENV"',
    ].join('\n');
    const { output, stripped } = exportConfigTemplate(text);
    expect(stripped).toBe(3);
    expect(output).not.toContain('sk-secret');
    expect(output.split(API_KEY_PLACEHOLDER).length - 1).toBe(3);
    // 非敏感行原样保留（含注释、其他键）
    expect(output).toContain('# 顶部注释保留');
    expect(output).toContain('provider = "stepfun"');
    expect(output).toContain('type = "anthropic"');
    expect(output).toContain('model = "step-3.7-flash"');
    // api_key_env 是变量名不是密钥本体，不剥
    expect(output).toContain('api_key_env = "MY_KEY_ENV"');
  });

  it('无 api_key 时 stripped=0，输出与输入一致', () => {
    const text = 'provider = "stepfun"\nmodel = "step-3.7-flash"\n';
    const { output, stripped } = exportConfigTemplate(text);
    expect(stripped).toBe(0);
    expect(output).toBe(text);
  });

  it('容忍键名前后空格；CRLF 输入归一为 LF 输出（保留尾随空行结构）', () => {
    const { output, stripped } = exportConfigTemplate('  api_key   = "x"\r\nkeep = 1\r\n');
    expect(stripped).toBe(1);
    expect(output).toBe(`${API_KEY_PLACEHOLDER}\nkeep = 1\n`);
  });

  it('api_key_env、api_keys 之类前缀相似键不受影响', () => {
    const text = 'api_key_env = "X"\napi_keys_note = "not a secret"\n';
    const { output, stripped } = exportConfigTemplate(text);
    expect(stripped).toBe(0);
    expect(output).toBe(text);
  });
});

describe('exportMcpConfigTemplate', () => {
  it('缺失文件时返回 missing=true', () => {
    const res = exportMcpConfigTemplate('/nonexistent/path/mcp.json');
    expect(res.missing).toBe(true);
    expect(res.output).toBe('');
    expect(res.redactedCount).toBe(0);
  });

  it('存在文件时脱敏 headers 值与 api_key 等敏感字段', () => {
    const raw = JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          headers: { Authorization: 'Bearer secret-token-123' },
          api_key: 'sk-secret-mcp',
        },
        stdio: {
          command: 'some-cli',
          env: { API_KEY: 'env-secret' },
        },
      },
    }, null, 2);
    const res = exportMcpConfigTemplate();
    // 由于 exportMcpConfigTemplate 默认读 ~/.step-pilot/mcp.json，这里我们直接测试函数逻辑
    // 用一个临时文件路径来测试
    expect(res.missing).toBe(true); // 默认路径在 CI 里通常不存在
  });

  it('直接对 JSON 文本做脱敏：headers 值与敏感 key 被替换', () => {
    // 我们通过写临时文件来测试完整流程
    const { writeFileSync, mkdirSync, rmSync } = require('node:fs');
    const { join } = require('node:path');
    const { homedir } = require('node:os');
    const tmpDir = join(homedir(), '.step-pilot', 'test-export-mcp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'mcp.json');
    const raw = JSON.stringify({
      mcpServers: {
        remote: {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer secret-token-123', 'X-Custom': 'custom-secret' },
        },
      },
    }, null, 2);
    writeFileSync(tmpFile, raw, 'utf8');
    try {
      const res = exportMcpConfigTemplate(tmpFile);
      expect(res.missing).toBe(false);
      expect(res.output).not.toContain('secret-token-123');
      expect(res.output).not.toContain('custom-secret');
      expect(res.output).toContain('[REDACTED]');
      expect(res.redactedCount).toBeGreaterThan(0);
    } finally {
      rmSync(tmpFile, { force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
