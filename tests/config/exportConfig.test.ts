import { describe, expect, it } from 'vitest';
import { API_KEY_PLACEHOLDER, exportConfigTemplate } from '../../src/config/exportConfig.js';

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
