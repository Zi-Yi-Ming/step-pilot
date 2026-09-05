import type Anthropic from '@anthropic-ai/sdk';

/**
 * Post-green termination 检测（Step ⑤ intervention，默认关闭）。
 *
 * 判定「本批工具结果里出现了完整 vitest suite 的全绿」，供 loop 的 tool_use 分支
 * 决定是否提前终止本 run。纯函数，不做任何 IO。
 *
 * 口径镜像声明：本文件的 vitest 识别与计数规则**逐条镜像**
 * `benchmark/analysis/validationMetrics.ts` 的 `isFilteredVitestRun` / `parseTestCounts`
 * （Step ①③ 封板口径）。分析层已封存不可反向 import，故此处独立实现——两处口径
 * 若需调整必须人工同步，否则实验的 attribution 与运行时判定会漂移。镜像理由：
 * 全量判据（无 `-t`/路径过滤）与计数级序（底部 `Tests` 汇总行、ANSI strip、
 * `no tests` 排除、横幅兜底）都踩过实测伪影，不重新发明。
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** 命令是否为带过滤的 vitest 执行（镜像 isFilteredVitestRun）。 */
export function isFilteredVitestCommand(command: string): boolean {
  const m = /vitest\s+run\b/.exec(command);
  if (m === null) return true;
  const rest = command.slice(m.index + m[0].length);
  const cutoff = rest.search(/\||&&|;/);
  const args = (cutoff === -1 ? rest : rest.slice(0, cutoff)).trim().split(/\s+/).filter(Boolean);
  if (args.some((a) => a === '-t' || a.startsWith('--testNamePattern'))) return true;
  const positionals = args.filter((a) => !a.startsWith('-') && !/^\d*[<>]&?\d*$/.test(a));
  return positionals.length > 0;
}

/**
 * 从 vitest 输出解析失败/通过/总数（镜像 parseTestCounts 级序）：
 * 1. strip ANSI；2. `no tests` 排除；3. 底部测试级汇总行（取最后一次）；
 * 4. `Failed Tests N` 横幅兜底（total 不可知记 0）；5. 全部缺失 → null。
 * 文件级 `Test Files N failed` 永不折算（伪 1F 伪影的根源）。
 */
export function parseVitestCounts(raw: string): { failed: number; passed: number; total: number } | null {
  const s = raw.replace(ANSI_RE, '');
  if (/no tests/i.test(s)) return null;
  const summaries = [...s.matchAll(/\bTests\s+(?:(\d+)\s+failed(?:\s*\|\s*(\d+)\s+passed)?|(\d+)\s+passed)(?:\s*\|\s*\d+\s+skipped)?(?:\s*\((\d+)\))?/g)];
  const last = summaries[summaries.length - 1];
  if (last !== undefined) {
    if (last[3] !== undefined) return { failed: 0, passed: Number(last[3]), total: Number(last[4] ?? 0) };
    return { failed: Number(last[1]), passed: Number(last[2] ?? 0), total: Number(last[4] ?? 0) };
  }
  const banner = s.match(/Failed\s+Tests\s+(\d+)/);
  if (banner !== null) return { failed: Number(banner[1]), passed: 0, total: 0 };
  return null;
}

/** 一个全量 suite 结果候选（failed=0 且 passed>0 才是 green）。 */
export interface FullSuiteCandidate {
  toolUseId: string;
  failed: number;
  passed: number;
  /** 底部汇总行括号内的总数；0 = 仅剩横幅、总数不可知。 */
  total: number;
}

const isBlockArray = (c: unknown): c is Array<{ type: string; [k: string]: unknown }> =>
  Array.isArray(c);

/** 提取消息 content 中的文本（tool_result 的 content 可为 string 或 text 块数组）。 */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isBlockArray(content)) {
    return content
      .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}

/**
 * 从「assistant（tool_use 发起）+ user（tool_result 结果）」两条消息中收集
 * 全量 vitest suite 的计数候选。命令来自 assistant 的 tool_use.input.command，
 * 结果按 tool_use_id 配对。非 bash、过滤跑、无汇总的执行不产生候选。
 */
export function collectFullSuiteCandidates(
  assistant: Anthropic.MessageParam,
  toolResult: Anthropic.MessageParam,
): FullSuiteCandidate[] {
  if (assistant.role !== 'assistant' || toolResult.role !== 'user') return [];
  if (!isBlockArray(assistant.content) || !isBlockArray(toolResult.content)) return [];

  // tool_use_id -> bash 命令（仅全量 vitest）
  const commands = new Map<string, string>();
  for (const block of assistant.content) {
    if (block.type !== 'tool_use') continue;
    const name = block.name;
    const input = block.input as { command?: unknown } | undefined;
    const command = typeof input?.command === 'string' ? input.command : '';
    if (name === 'bash' && !isFilteredVitestCommand(command)) {
      commands.set(String(block.id), command);
    }
  }
  if (commands.size === 0) return [];

  const out: FullSuiteCandidate[] = [];
  for (const block of toolResult.content) {
    if (block.type !== 'tool_result') continue;
    const id = String(block.tool_use_id);
    const command = commands.get(id);
    if (command === undefined) continue;
    const counts = parseVitestCounts(resultText(block.content));
    if (counts === null) continue;
    out.push({ toolUseId: id, failed: counts.failed, passed: counts.passed, total: counts.total });
  }
  return out;
}

/**
 * 应用 suite 不收缩守卫：候选中第一个 failed===0 且 passed>0 且 total ≥ maxSuiteTotal
 * 的即触发。maxSuiteTotal 为本 run 此前所有全量 checkpoint 的最大 total（首绿时为 0，
 * 直接触发）；守卫拦截「删测试凑绿」——total 收缩的全绿回落自然行为。
 */
export function pickPostGreen(
  candidates: readonly FullSuiteCandidate[],
  maxSuiteTotal: number,
): FullSuiteCandidate | null {
  return (
    candidates.find((c) => c.failed === 0 && c.passed > 0 && c.total >= maxSuiteTotal) ?? null
  );
}
