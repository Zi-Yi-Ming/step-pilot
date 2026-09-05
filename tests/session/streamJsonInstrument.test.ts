import { describe, expect, it } from 'vitest';
import {
  STREAM_JSON_PROTOCOL_VERSION,
  agentEventLine,
  createStreamInstrument,
  stampedLine,
  type StreamClockSource,
} from '../../src/session/streamJson.js';

/** 假时钟源：wall/mono 由调用次数驱动，间隔固定且 wall > mono，便于区分两个钟。 */
function fakeClock(): StreamClockSource & { ticks: number } {
  let ticks = 0;
  return {
    get ticks(): number {
      return ticks;
    },
    wall: () => {
      ticks++;
      return 1_000_000 + ticks * 100;
    },
    mono: () => {
      ticks++;
      return ticks * 10;
    },
  };
}

describe('stream-json v4 instrumentation（observationally neutral）', () => {
  it('协议版本升到 4（新增 ts/mono/turn 字段）', () => {
    expect(STREAM_JSON_PROTOCOL_VERSION).toBe(4);
  });

  it('turn 计数：只在 thinking_start 递增，其余事件携带当前轮次，首轮前为 0', () => {
    const inst = createStreamInstrument(fakeClock());
    expect(inst.turn).toBe(0);
    inst.sample(); // 非 thinking 事件取样不改变轮次
    expect(inst.turn).toBe(0);
    inst.onThinkingStart();
    expect(inst.turn).toBe(1);
    inst.sample();
    inst.sample();
    expect(inst.turn).toBe(1);
    inst.onThinkingStart();
    inst.onThinkingStart();
    expect(inst.turn).toBe(3);
  });

  it('双钟语义：sample() 三字段同源，ts 为墙钟、mono 为单调钟', () => {
    const clock = fakeClock();
    const inst = createStreamInstrument(clock);
    const s = inst.sample();
    expect(s.ts).toBeGreaterThan(s.mono); // 假钟设计：wall 基线 1e6 > mono 基线
    expect(Number.isFinite(s.ts)).toBe(true);
    expect(Number.isFinite(s.mono)).toBe(true);
    expect(Number.isInteger(s.turn)).toBe(true);
  });

  it('时钟单调性：连续取样 ts 与 mono 均非递减', () => {
    const clock = fakeClock();
    const inst = createStreamInstrument(clock);
    let prevTs = -Infinity;
    let prevMono = -Infinity;
    for (let i = 0; i < 50; i++) {
      if (i % 3 === 0) inst.onThinkingStart();
      const s = inst.sample();
      expect(s.ts).toBeGreaterThanOrEqual(prevTs);
      expect(s.mono).toBeGreaterThanOrEqual(prevMono);
      prevTs = s.ts;
      prevMono = s.mono;
    }
  });

  it('agentEventLine 带 clock：原 payload 字段全部保留，仅新增 ts/mono/turn', () => {
    const inst = createStreamInstrument(fakeClock());
    inst.onThinkingStart();
    const ev = { type: 'tool_start', id: 't1', name: 'bash', input: { command: 'npx vitest run' } };
    const parsed = JSON.parse(agentEventLine(ev, inst.sample())) as Record<string, unknown>;
    expect(parsed).toMatchObject({ type: 'tool_start', id: 't1', name: 'bash', input: { command: 'npx vitest run' } });
    expect(Object.keys(parsed).sort()).toEqual(['id', 'input', 'mono', 'name', 'ts', 'turn', 'type']);
  });

  it('agentEventLine 不带 clock：输出与 v3 逐字节一致（payload 语义不变的兼容锚点）', () => {
    const ev = { type: 'tool_end', id: 't1', name: 'bash', result: 'ok', isError: false };
    expect(agentEventLine(ev)).toBe(JSON.stringify(ev));
    expect(agentEventLine(ev)).toBe('{"type":"tool_end","id":"t1","name":"bash","result":"ok","isError":false}');
  });

  it('error 事件：clock 存在时仍剥离 cause，但带标注', () => {
    const inst = createStreamInstrument(fakeClock());
    const ev = { type: 'error', message: 'boom', cause: new Error('internal-with-headers') };
    const parsed = JSON.parse(agentEventLine(ev, inst.sample())) as Record<string, unknown>;
    expect(parsed).toEqual({ type: 'error', message: 'boom', ts: expect.any(Number), mono: expect.any(Number), turn: 0 });
    expect(JSON.stringify(parsed)).not.toContain('internal-with-headers');
  });

  it('stampedLine：标注字段显式覆盖事件体内的同名字段', () => {
    const inst = createStreamInstrument(fakeClock());
    inst.onThinkingStart();
    const line = JSON.parse(stampedLine({ type: 'subagent.start', subagent_type: 'x', description: 'd', ts: -1, turn: 99 }, inst.sample())) as Record<string, unknown>;
    expect(line.ts).toBeGreaterThan(0);
    expect(line.turn).toBe(1);
    expect(line.subagent_type).toBe('x');
  });

  it('stampedLine 不改变事件体其余字段', () => {
    const ev = { type: 'result', subtype: 'success', durationMs: 42, sessionId: 's1' };
    const parsed = JSON.parse(stampedLine(ev, { ts: 5, mono: 1, turn: 7 })) as Record<string, unknown>;
    expect(parsed).toEqual({ type: 'result', subtype: 'success', durationMs: 42, sessionId: 's1', ts: 5, mono: 1, turn: 7 });
  });

  it('端到端发射序列（emit 侧逻辑的语义等价重放）：turn 与事件流对齐', () => {
    // 复刻 cli.ts emit 的 streamJson 分支逻辑，验证 turn 标注与 segmentTurns 口径一致：
    // thinking_start 自身携带递增后的新轮次，其后的事件同轮次。
    const inst = createStreamInstrument(fakeClock());
    const lines: Array<Record<string, unknown>> = [];
    const emitLike = (ev: { type: string }): void => {
      if (ev.type === 'thinking_start') inst.onThinkingStart();
      lines.push(JSON.parse(agentEventLine(ev, inst.sample())) as Record<string, unknown>);
    };
    emitLike({ type: 'notice', message: 'early' }); // 首轮前 meta 事件
    emitLike({ type: 'thinking_start' });
    emitLike({ type: 'tool_start', id: 'a', name: 'bash', input: {} });
    emitLike({ type: 'tool_end', id: 'a', name: 'bash', result: 'r', isError: false });
    emitLike({ type: 'thinking_start' });
    emitLike({ type: 'usage', totalTokens: 10, billedDelta: 5 });
    expect(lines.map((l) => l.turn)).toEqual([0, 1, 1, 1, 2, 2]);
  });
});
