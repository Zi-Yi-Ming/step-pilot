import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

/**
 * Post-green termination 的 loop 接线测试：
 * - flag 开启 + 全量 vitest 全绿 → 当回合收尾终止（notice + turn_done，不再发起模型调用）
 * - flag 关闭 → 与 9c1881b 基线行为逐事件一致（继续下一回合模型调用）
 *
 * bash 工具真实执行：命令用 echo 伪造 vitest 汇总行（不真跑 vitest）。
 * 命令含字面 `vitest run` 且 run 后到 && 之间无位置参数 → 判为全量。
 */
const GREEN_CMD = 'echo vitest run && echo "Tests  0 failed | 12 passed (12)"';

function sm(message: Parameters<typeof stored>[0], origin: 'user' | 'assistant' | 'tool'): StoredMessage {
  return stored(message, { kind: origin });
}

const baseOpts = (provider: ReturnType<typeof makeFakeProvider>['provider'], messages: StoredMessage[], postGreenTermination?: boolean) => ({
  provider,
  system: 'sys',
  ctx: { cwd: process.cwd() },
  messages,
  postGreenTermination,
});

describe('post-green termination 接线（loop 级）', () => {
  it('flag 开启 + 全量全绿：当回合终止，notice + turn_done，不再调用模型', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [toolUseBlock('call_1', 'bash', { command: GREEN_CMD })],
      },
      // 若误继续，第二回合存在即可被 streamCalls 捕获
      { textChunks: ['不该出现'], finalContent: [textBlock('不该出现')] },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'fix the tests' }, 'user')];
    const events = await collect(runAgent(baseOpts(provider, messages, true)));

    expect(streamCalls()).toBe(1); // 全绿后不再发起第二次模型调用
    const notice = events.find((e) => e.type === 'notice') as { type: 'notice'; message: string } | undefined;
    expect(notice?.message).toContain('12');
    expect(notice?.message).toContain('全量测试套件');
    expect(events.at(-1)!.type).toBe('turn_done');
    // 工具结果已回灌（成功路径的完整配对），但模型没有机会再收尾
    expect(messages).toHaveLength(3);
    expect(messages[2]!.origin.kind).toBe('tool');
  });

  it('flag 开启 + 测试失败：不触发，继续下一回合', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [toolUseBlock('call_1', 'bash', { command: 'echo vitest run && echo "Tests  10 failed | 2 passed (12)"' })],
      },
      { textChunks: ['继续修'], finalContent: [textBlock('继续修')] },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'fix' }, 'user')];
    const events = await collect(runAgent(baseOpts(provider, messages, true)));

    expect(streamCalls()).toBe(2);
    expect(events.some((e) => e.type === 'notice' && (e as { message: string }).message.includes('全量测试套件'))).toBe(false);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('同批内先膨胀后收缩：[全量 10F@15, 全量 0F@12] 并存 → 不触发（shrink guard 覆盖同批，Phase 2.6 修复）', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          // 同一 assistant 消息里的两个全量 bash tool_use：套件先膨胀到 15（红）、
          // 又以 12（绿）出现——12 < 同批 max(15)，按「先更新后判定」必须拦截。
          toolUseBlock('call_1', 'bash', { command: 'echo vitest run && echo "Tests  10 failed | 5 passed (15)"' }),
          toolUseBlock('call_2', 'bash', { command: 'echo vitest run && echo "Tests  0 failed | 12 passed (12)"' }),
        ],
      },
      { textChunks: ['继续'], finalContent: [textBlock('继续')] },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'fix' }, 'user')];
    const events = await collect(runAgent(baseOpts(provider, messages, true)));

    expect(streamCalls()).toBe(2); // 被守卫拦截 → 回落自然行为，继续下一回合
    expect(events.some((e) => e.type === 'notice' && (e as { message: string }).message.includes('全量测试套件'))).toBe(false);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('flag 关闭：与基线行为一致——同样的全绿结果继续下一回合模型调用', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [toolUseBlock('call_1', 'bash', { command: GREEN_CMD })],
      },
      { textChunks: ['全部通过，任务完成'], finalContent: [textBlock('全部通过，任务完成')] },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'fix the tests' }, 'user')];
    const events = await collect(runAgent(baseOpts(provider, messages)));

    expect(streamCalls()).toBe(2); // 基线：模型继续收尾
    expect(events.some((e) => e.type === 'notice' && (e as { message: string }).message.includes('全量测试套件'))).toBe(false);
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('全部通过，任务完成');
    expect(events.at(-1)!.type).toBe('turn_done');
  });
});
