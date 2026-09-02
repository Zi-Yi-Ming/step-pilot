import { describe, expect, it } from 'vitest';
import { executeTool } from '../../src/tools/index.js';

function makeCtx(overrides: Partial<{ background: any }> = {}) {
  return {
    cwd: process.cwd(),
    ...overrides,
  } as any;
}

describe('executeTool 入参容错（Flash 小模型常见格式错误）', () => {
  it('字符串 "true"/"false" 自动转布尔，重试后成功', async () => {
    const result = await executeTool('bash', { command: 'echo hello', run_in_background: 'true' }, makeCtx({ background: { start: () => 'task-id' } }));
    expect(result.isError).toBe(false);
    // run_in_background=true 会走后台路径，返回任务启动消息而非命令输出，这是正常行为
    expect(result.content).toContain('task-id');
  });

  it('数值字符串自动转数字，重试后成功', async () => {
    const result = await executeTool('read_file', { path: 'package.json', offset: '1' }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('name');
  });

  it('完全无效的输入仍然原样报错，不强行解释', async () => {
    const result = await executeTool('bash', 'not-an-object' as any, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('入参校验失败');
  });

  it('未知工具名直接报错，不进入容错', async () => {
    const result = await executeTool('unknown_tool', {}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('未知工具');
  });
});
