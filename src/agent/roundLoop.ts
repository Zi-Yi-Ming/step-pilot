/**
 * 跨回合零进展检测（round loop guard）——纯函数模块。
 *
 * 背景：模型在 tool_use 分支陷入「看到相同工具结果 → 做出相同反应」的稳态，
 * 每轮产出的 assistant 消息与工具结果逐字节相同，没有信息增量。
 * 该病态不在流内（thinkingLoop 管不着）、不在续写链路（continuation 管不着），
 * 只出现在 `loop.ts` 的 `tool_use` 分支走 continue 时。
 *
 * 本模块用「回合指纹」做确定性判据：完整字符串相等是二值判断，误报空间为零。
 * 完整设计与阈值理据见内部产品设计文档（跨回合零进展检测设计）。
 *
 * 无 IO、状态显式、与 continuation.ts 同风格。
 */

import type { StoredMessage } from './message.js';

/* ------------------------------------------------------------------ */
/* 类型定义                                                           */
/* ------------------------------------------------------------------ */

/**
 * 检测结果。
 * - none：正常，无干预。
 * - warn：连续相同第 3 次，已注入警告，继续一轮。
 * - stop：连续相同第 4 次（含）以上，判定死循环，停止本轮。
 */
export type RoundLoopVerdict =
  | { action: 'none' }
  | { action: 'warn'; streak: number }
  | { action: 'stop'; streak: number };

/* ------------------------------------------------------------------ */
/* 指纹生成                                                           */
/* ------------------------------------------------------------------ */

/**
 * 从 messages 尾部取「最后一条 assistant 消息（倒数第二条）+ 紧随其后的 tool_result user 消息（最后一条）」，
 * 拼出稳定指纹字符串。尾部结构不匹配返回 null。
 *
 * "最后一条 assistant" = 从尾部扫描，最后一条 role='assistant' 的消息。
 * "紧随的 tool_result user" = 紧跟在 assistant 之后的那条 role='user' 消息（工具结果回灌）。
 *
 * 排除 tool_use id 与消息 ts——这两样每轮必然不同，含了指纹永远不等、检测静默失效。
 *
 * @param messages 完整 storage 历史（只读，不修改）
 */
export function fingerprintRound(messages: StoredMessage[]): string | null {
  if (messages.length < 2) return null;

  // 尾部两条：[倒数第二 = assistant, 倒数第一 = tool_result user]
  const assistantMsg = messages[messages.length - 2]!;
  const resultMsg = messages[messages.length - 1]!;

  if (assistantMsg.message.role !== 'assistant') return null;
  if (resultMsg.message.role !== 'user') return null;

  // ---------- assistant 侧 ----------
  const assistantContent = assistantMsg.message.content;
  let assistantFingerprint = '';

  if (typeof assistantContent === 'string') {
    assistantFingerprint = `t:${normalizeNumericTokens(assistantContent)}`;
  } else if (Array.isArray(assistantContent)) {
    const parts: string[] = [];
    for (const block of assistantContent) {
      if (block.type === 'text') {
        // text 块原文直接参与指纹
        parts.push(`t:${normalizeNumericTokens(block.text)}`);
      } else if (block.type === 'tool_use') {
        // tool_use 的 name + input 参与指纹，不含 id
        parts.push(`u:${block.name}:${normalizeInput(block.input)}`);
      }
      // thinking 等非 text/tool_use 块忽略（它们是思考过程，不改变工具调用语义）
    }
    assistantFingerprint = parts.join('|');
  }

  if (assistantFingerprint === '') return null;

  // ---------- tool_result 侧 ----------
  const toolContent = resultMsg.message.content;
  let toolFingerprint = '';

  if (typeof toolContent === 'string') {
    toolFingerprint = `r:${normalizeNumericTokens(toolContent)}`;
  } else if (Array.isArray(toolContent)) {
    const parts: string[] = [];
    for (const block of toolContent) {
      if (block.type !== 'tool_result') continue;

      // is_error 参与指纹：错误复读也是复读
      const errFlag = block.is_error === true ? 'e' : 'o';

      if (typeof block.content === 'string') {
        parts.push(`${errFlag}:${normalizeNumericTokens(block.content)}`);
      } else if (Array.isArray(block.content)) {
        // 块数组形态：取所有 text 块拼接（忽略图片等不可序列化块）
        const texts: string[] = [];
        for (const inner of block.content) {
          if (inner.type === 'text') texts.push(inner.text);
        }
        parts.push(`${errFlag}:${normalizeNumericTokens(texts.join(''))}`);
      }
      // 无 content 的 tool_result 记为空串
    }
    toolFingerprint = parts.join('|');
  }

  return `${assistantFingerprint}||${toolFingerprint}`;
}

/* ------------------------------------------------------------------ */
/* 数值量级归一（G3：漂移式重复调用逃逸）                              */
/* ------------------------------------------------------------------ */

/**
 * 数值字面量归一化：把数字折叠成「量级 + 尾数前缀」，让 2e10 与 3.6e76 归到同一指纹。
 *
 * 为什么需要：指纹原先是**精确字符串相等**，而模型的漂移式复读常常每一步把某个数值
 * 推大一点（如翻倍计算、递归累乘），assistant 文本与工具结果都逐轮微变，精确相等
 * 永远不成立——检测器全程静默，循环逃逸。归一到量级后，"同一件事在重复做、只是数字
 * 在变大" 这一模式才落在同一个指纹上。
 *
 * 保留度：符号 + 十的科学计数法，形如 `+#3.4`（正数，10^3 量级，尾数 .4）。
 * 只保留尾数一位小数是刻意的——再多就退化成精确匹配，量级归一失去意义。
 * 整数与浮点一律走同一路径（`12` → `+#1.1`，`12.0` 亦同），保证 2e10 与 20000000000
 * 也归一。科学计数法、普通小数、带正负号的形态都被这条正则吃掉。
 *
 * 边界：会误伤「数字本身就是语义」的场景（如结果 `2 errors` 与 `3 errors` 被归一），
 * 但两者本就属于同一类重复行为，归并到同一指纹是期望行为而非缺陷。
 */
const NUMBER_TOKEN = /[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function normalizeNumericTokens(text: string): string {
  return text.replace(NUMBER_TOKEN, (raw) => numericBucket(raw));
}

/** 单个数值 → 量级桶标签。无法解析（NaN/Infinity）时原样返回，避免误归。 */
function numericBucket(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  if (value === 0) return '±#0';
  const sign = value < 0 ? '-' : '+';
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const mantissa = Math.round((Math.abs(value) / 10 ** magnitude) * 10) / 10;
  return `${sign}#${magnitude}.${mantissa.toFixed(1)}`;
}

/**
 * tool_use.input 归一：递归重写对象/数组里的**字符串**数值 token 与数字字面量，
 * 其余结构（键名、布尔、null）原样保留。
 *
 * JSON.stringify 的 replacer 无法表达「把数字 2e10 换成标签」，所以在序列化之前
 * 先做一次深拷贝式重写，再交给 JSON.stringify。
 */
function normalizeInput(input: unknown): string {
  return JSON.stringify(rewriteNumbers(input));
}

function rewriteNumbers(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? numericBucket(String(value)) : String(value);
  }
  if (typeof value === 'string') return normalizeNumericTokens(value);
  if (Array.isArray(value)) return value.map(rewriteNumbers);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteNumbers(v);
    }
    return out;
  }
  return value;
}


/* ------------------------------------------------------------------ */
/* 检测器（有状态，闭包持有窗口）                                       */
/* ------------------------------------------------------------------ */

/**
 * 滑动窗口大小。选 8 的理由：
 * - 8 ≥ 4×2，能覆盖周期 2、3、4 的交替循环；
 * - 窗口内出现 4 次意味着至少绕了 4 圈，误报空间为零（合法轮询不会在 8 轮内 4 次产出完全相同的指纹）。
 */
const WINDOW_SIZE = 8;

/**
 * 阈值理据：
 *
 * - 窗口内出现 1、2 次不触发（`action: 'none'`）：合理确认性重试（模型复核一次结果）
 *   在两轮内完成，正常任务极少出现 3 次完全相同的情况。
 * - 窗口内出现恰好 3 次 → `action: 'warn'`：与 `thinkingLoop.ts` 的 `REPEAT_THRESHOLD=3` 口径一致；
 *   3 次相同说明模型大概率卡住，但偶发（如网络抖动导致模型重发同一条调用）仍有可能，
 *   先注入警告给一次机会。
 * - 窗口内出现 4 次及以上 → `action: 'stop'`：与 thinkingLoop「诱导重试最多 1 次」、
 *   hooks「续行只给一次机会」同款收敛策略——给机会是为了不冤枉偶发，给完还犯就是真困住，
 *   继续烧全量上下文没有价值。
 * - streak ≥ 5 理论上在 stop 后不会发生（loop 已停），函数保持有定义行为。
 *
 * streak 字段语义：从「连续轮数」变为「窗口内出现次数」。调用方仅用它做展示，
 * 类型名与字段名保持不变。
 */
export function createRoundLoopDetector(): {
  observe(fingerprint: string | null): RoundLoopVerdict;
  reset(): void;
} {
  /** 最近 WINDOW_SIZE 轮的指纹（新元素追加到尾部）。 */
  const window: string[] = [];

  /**
   * 观察一轮的指纹，返回处置建议。
   * 调用方按 action 决定：none → 继续；warn → 注入警告后继续；stop → 停止。
   *
   * streak 字段语义：当前指纹在滑动窗口内（含本轮）出现的次数。
   */
  function observe(fingerprint: string | null): RoundLoopVerdict {
    // null = 尾部结构不匹配或首轮，清零窗口
    if (fingerprint === null) {
      window.length = 0;
      return { action: 'none' };
    }

    // 追加当前指纹
    window.push(fingerprint);

    // 维持窗口大小
    while (window.length > WINDOW_SIZE) {
      window.shift();
    }

    // 统计当前指纹在窗口内出现次数
    const count = window.filter((fp) => fp === fingerprint).length;

    if (count >= 4) {
      return { action: 'stop', streak: count };
    }
    if (count === 3) {
      return { action: 'warn', streak: 3 };
    }
    // count 1、2：不干预
    return { action: 'none' };
  }

  function reset(): void {
    window.length = 0;
  }

  return { observe, reset };
}
