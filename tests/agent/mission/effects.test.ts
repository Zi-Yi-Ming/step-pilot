/**
 * Mission 副作用账本测试。
 *
 * 两层：
 * - 纯函数层（deriveEffects）：注入消息序列，覆盖分类（mutating / read-only / unknown）、
 *   三态判定（completed / failed / uncertain）、合成占位识别、摘要提取。
 * - 恢复计划集成：effects 经 SessionInspection 进入 buildRecoveryPlan 的
 *   needsConfirmation / warnings / steps（在 resume.test.ts 的 CLI 层有真会话用例）。
 */
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

import { DANGLING_TOOL_RESULT_TEXT } from '../../../src/agent/toolClosure.js';
import { deriveEffects, uncertainEffects, type MissionEffect } from '../../../src/agent/mission/effects.js';

type Msg = { message: Anthropic.MessageParam };

function assistant(blocks: Anthropic.ContentBlockParam[]): Msg {
  return { message: { role: 'assistant', content: blocks } };
}
function user(blocks: Anthropic.ContentBlockParam[]): Msg {
  return { message: { role: 'user', content: blocks } };
}
function toolUse(id: string, name: string, input: unknown): Anthropic.ContentBlockParam {
  return { type: 'tool_use', id, name, input } as Anthropic.ContentBlockParam;
}
function toolResult(id: string, content: string, isError = false): Anthropic.ContentBlockParam {
  return { type: 'tool_result', tool_use_id: id, content, is_error: isError } as Anthropic.ContentBlockParam;
}

function byId(effects: MissionEffect[], id: string): MissionEffect {
  const e = effects.find((x) => x.effectId === id);
  expect(e).toBeDefined();
  return e!;
}

describe('deriveEffects：分类', () => {
  it('write_file / edit_file / bash 进账本；已知只读工具不进', () => {
    const effects = deriveEffects([
      assistant([toolUse('c1', 'write_file', { path: 'src/a.ts', content: 'x' })]),
      assistant([toolUse('c2', 'read_file', { path: 'src/a.ts' })]),
      assistant([toolUse('c3', 'grep', { pattern: 'x' })]),
      assistant([toolUse('c4', 'edit_file', { path: 'src/b.ts' })]),
      assistant([toolUse('c5', 'bash', { command: 'pnpm build' })]),
      assistant([toolUse('c6', 'todo_list', { todos: [] })]),
      assistant([toolUse('c7', 'ask_user', { questions: [] })]),
    ]);
    expect(effects.map((e) => e.effectId)).toEqual(['c1', 'c4', 'c5']);
    expect(effects.map((e) => e.kind)).toEqual(['write_file', 'edit_file', 'bash']);
  });

  it('未知工具（MCP / 编排类）按 unknown 保守纳入', () => {
    const effects = deriveEffects([
      assistant([toolUse('m1', 'mcp__browser__click', { selector: '#submit' })]),
      assistant([toolUse('s1', 'spawn_agent', { prompt: '改文件' })]),
      assistant([toolUse('w1', 'web_search', { query: 'x' })]), // 只读对照
    ]);
    expect(effects.map((e) => e.effectId)).toEqual(['m1', 's1']);
    expect(effects.every((e) => e.kind === 'unknown')).toBe(true);
  });
});

describe('deriveEffects：三态判定', () => {
  it('正常配对 → completed；is_error → failed；两者都是确定的事实', () => {
    const effects = deriveEffects([
      assistant([toolUse('c1', 'write_file', { path: 'a.ts' })]),
      user([toolResult('c1', 'ok: wrote 10 bytes')]),
      assistant([toolUse('c2', 'bash', { command: 'exit 1' })]),
      user([toolResult('c2', 'command failed', true)]),
    ]);
    expect(byId(effects, 'c1').status).toBe('completed');
    expect(byId(effects, 'c1').detail).toBe('ok: wrote 10 bytes');
    expect(byId(effects, 'c2').status).toBe('failed');
  });

  it('无配对（悬空）→ uncertain，即使它不是末尾调用', () => {
    const effects = deriveEffects([
      assistant([toolUse('c1', 'write_file', { path: 'a.ts' })]),
      // c1 从未得到结果
      assistant([toolUse('c2', 'bash', { command: 'ls' })]),
      user([toolResult('c2', 'file list')]),
    ]);
    expect(byId(effects, 'c1').status).toBe('uncertain');
    expect(byId(effects, 'c2').status).toBe('completed');
  });

  it('合成占位文案配对 → uncertain（resume 闭合过的会话同语义）', () => {
    const effects = deriveEffects([
      assistant([toolUse('c1', 'write_file', { path: 'half-written.ts' })]),
      user([toolResult('c1', DANGLING_TOOL_RESULT_TEXT, true)]),
    ]);
    const e = byId(effects, 'c1');
    expect(e.status).toBe('uncertain');
    expect(e.detail).toContain('中断');
  });

  it('uncertainEffects 只返回未闭环子集', () => {
    const effects = deriveEffects([
      assistant([toolUse('c1', 'write_file', { path: 'a.ts' })]),
      user([toolResult('c1', 'ok')]),
      assistant([toolUse('c2', 'bash', { command: 'rm -rf x' })]),
    ]);
    expect(uncertainEffects(effects).map((e) => e.effectId)).toEqual(['c2']);
  });
});

describe('deriveEffects：摘要与健壮性', () => {
  it('摘要：write/edit 取 path，bash 取命令并截断，unknown 序列化输入', () => {
    const effects = deriveEffects([
      assistant([toolUse('c1', 'write_file', { path: 'src/payment.ts', content: 'x' })]),
      assistant([toolUse('c2', 'bash', { command: 'x'.repeat(200) })]),
      assistant([toolUse('c3', 'mcp__db__query', { sql: 'DELETE FROM t' })]),
    ]);
    expect(byId(effects, 'c1').summary).toBe('write_file: src/payment.ts');
    expect(byId(effects, 'c2').summary.startsWith('bash: xxxx')).toBe(true);
    expect(byId(effects, 'c2').summary.length).toBeLessThanOrEqual(100);
    expect(byId(effects, 'c3').summary).toContain('mcp__db__query');
    expect(byId(effects, 'c3').summary).toContain('DELETE FROM t');
  });

  it('input 缺失 / 非对象 / content 为字符串时都不抛错', () => {
    const effects = deriveEffects([
      assistant([{ type: 'tool_use', id: 'c1', name: 'bash' } as Anthropic.ContentBlockParam]),
      user([{ type: 'tool_result', tool_use_id: 'c1', content: 'done' } as Anthropic.ContentBlockParam]),
      { message: { role: 'user', content: '纯文本消息' } }, // 非数组 content 直接跳过
    ]);
    expect(byId(effects, 'c1').status).toBe('completed');
    expect(effects).toHaveLength(1);
  });

  it('纯函数：不修改入参消息数组', () => {
    const messages = [
      assistant([toolUse('c1', 'write_file', { path: 'a.ts' })]),
      user([toolResult('c1', 'ok')]),
    ];
    const snapshot = JSON.stringify(messages);
    deriveEffects(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});
