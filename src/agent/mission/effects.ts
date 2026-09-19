/**
 * Mission 副作用账本（effect ledger）。
 *
 * 定位：从**会话事实源**（快照 + wire 重放重建的消息序列）确定性推导「这个任务动过
 * 什么、每笔副作用是否闭环」。刻意**不在** agent 执行期往 Mission 事件日志写
 * effect.started / effect.completed——会话消息已经是唯一事实源，再落一份账本就是第二份
 * 会漂移的记录（G7 教训）。分析时推导，推导是纯函数；Mission 与会话生命周期分离的
 * 既有纪律（Mission 不写进会话 wire）同样适用。
 *
 * 为什么需要它：悬空 tool_use 检测只回答「末尾有没有没跑完的调用」；账本回答的是
 * 「这个任务的每一笔**可能改变世界**的调用，结果是否确定」。未闭环副作用（uncertain）
 * 意味着进程可能死在副作用中途——文件可能处于半写状态——这比 git 漂移精确到笔。
 *
 * 分类纪律（宁可误报进账本，不可漏报）：
 * - 按名明确的改动类：write_file / edit_file / bash（bash 汇总命令本身）。
 * - 已知只读类不进账本（读 / 搜 / 列 / 抓取 / 清单 / 交互）。
 * - 其余一切（MCP 工具、spawn_agent、dynamic_workflow、未来新工具）按「可能改外部
 *   世界」保守纳入，kind 'unknown'——子 agent 与工作流的副作用在 git 漂移里可见，
 *   但「发起过一次编排」这件事只有账本记得。
 *
 * 状态语义：
 * - completed：有配对 tool_result，非 error（真实成功）。
 * - failed：有配对 tool_result 且 is_error——**真实失败也是确定的事实**，与 uncertain 分列。
 * - uncertain：无配对（悬空），或配对结果是 DANGLING_TOOL_RESULT_TEXT 合成占位
 *   （resume 闭合过的会话）。两种形态同一含义：真实结果丢失。
 */
import type Anthropic from '@anthropic-ai/sdk';
import { DANGLING_TOOL_RESULT_TEXT } from '../toolClosure.js';

export type MissionEffectKind = 'write_file' | 'edit_file' | 'bash' | 'unknown';
export type MissionEffectStatus = 'completed' | 'failed' | 'uncertain';

export interface MissionEffect {
  /** tool_use id（会话内唯一，即账本行标识）。 */
  effectId: string;
  kind: MissionEffectKind;
  /** 工具名原样（MCP 名如 mcp__srv__tool 原样保留）。 */
  tool: string;
  /** 人读摘要：write/edit 取 path，bash 取命令，其余取工具名 + 输入截断。 */
  summary: string;
  status: MissionEffectStatus;
  /** 结果摘要（截断）。uncertain 时是丢失说明。 */
  detail?: string;
}

const MUTATING_BY_NAME: Record<string, MissionEffectKind> = {
  write_file: 'write_file',
  edit_file: 'edit_file',
  bash: 'bash',
};

/** 已知只读工具白名单：这些调用没有任务级副作用，不进账本。 */
const READ_ONLY = new Set([
  'read_file',
  'read_media',
  'list_dir',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'web_image_search',
  'skill',
  'skill_search',
  'tool_search',
  'todo_list',
  'ask_user',
  'exit_plan_mode',
]);

const SUMMARY_MAX = 80;
const DETAIL_MAX = 200;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 从 tool_use 的 input 里提取人读摘要。input 形状不保证，一律防御式取值。 */
function summarize(kind: MissionEffectKind, tool: string, input: unknown): string {
  const rec = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if ((kind === 'write_file' || kind === 'edit_file') && typeof rec['path'] === 'string') {
    return `${tool}: ${rec['path']}`;
  }
  if (kind === 'bash' && typeof rec['command'] === 'string') {
    return `${tool}: ${clip(rec['command'], SUMMARY_MAX)}`;
  }
  try {
    return `${tool}: ${clip(JSON.stringify(rec) ?? '{}', SUMMARY_MAX)}`;
  } catch {
    return `${tool}: (unserializable input)`;
  }
}

/** 把 tool_result 的 content（字符串或块数组）摊平成文本。 */
function resultText(content: Anthropic.ToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

interface OpenEffect {
  effectId: string;
  kind: MissionEffectKind;
  tool: string;
  summary: string;
}

/**
 * 从消息序列推导副作用账本（纯函数，不修改入参）。
 *
 * 入参是结构最小化的一层（只要 `.message`），StoredMessage 与裸 MessageParam 都能喂。
 * 只读工具直接跳过；账本按工具调用出现顺序排列。
 */
export function deriveEffects(
  messages: readonly { message: Anthropic.MessageParam }[],
): MissionEffect[] {
  const open = new Map<string, OpenEffect>();
  const out: MissionEffect[] = [];
  for (const m of messages) {
    const content = m.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use') {
        const kind = MUTATING_BY_NAME[block.name] ?? (READ_ONLY.has(block.name) ? null : 'unknown');
        if (kind === null) continue;
        const effect: OpenEffect = {
          effectId: block.id,
          kind,
          tool: block.name,
          summary: summarize(kind, block.name, block.input),
        };
        open.set(block.id, effect);
        out.push({ effectId: block.id, kind, tool: block.name, summary: effect.summary, status: 'uncertain' });
        continue;
      }
      if (block.type === 'tool_result') {
        const effect = open.get(block.tool_use_id);
        if (effect === undefined) continue;
        const idx = out.findIndex((e) => e.effectId === block.tool_use_id);
        const entry = out[idx]!;
        const isError = block.is_error === true;
        const text = resultText(block.content).trim();
        if (text === DANGLING_TOOL_RESULT_TEXT) {
          // resume 闭合的合成占位：真实结果丢失，与悬空同语义
          entry.status = 'uncertain';
          entry.detail = '结果被中断占位替换：进程很可能死在该副作用执行中途。';
        } else if (isError) {
          entry.status = 'failed';
          entry.detail = clip(text, DETAIL_MAX);
        } else {
          entry.status = 'completed';
          entry.detail = clip(text, DETAIL_MAX);
        }
        open.delete(block.tool_use_id);
      }
    }
  }
  return out;
}

/** 账本中未闭环的副作用（进程可能死在中间的那部分）。 */
export function uncertainEffects(effects: readonly MissionEffect[]): MissionEffect[] {
  return effects.filter((e) => e.status === 'uncertain');
}
