import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { askUserTool } from './askUser.js';
import { bashTool } from './bash.js';
import { dynamicWorkflowTool } from './dynamicWorkflow.js';
import { editFileTool } from './edit.js';
import { exitPlanModeTool } from './exitPlanMode.js';
import { globTool } from './glob.js';
import { createGoalTool, getGoalTool, setGoalBudgetTool, updateGoalTool } from './goal.js';
import {
  teamInboxTool,
  teamInitTool,
  teamMergeTool,
  teamPlanTool,
  teamSendTool,
  teamSpawnTool,
  teamStatusTool,
  teamTeardownTool,
} from './team.js';
import { grepTool } from './grep.js';
import { imageSearchTool } from './imageSearch.js';
import { listDirTool } from './listDir.js';
import { readFileTool } from './readFile.js';
import { readMediaTool } from './readMedia.js';
import { spawnAgentTool } from './spawnAgent.js';
import { skillTool } from './skill.js';
import { skillSearchTool } from './skillSearch.js';
import { taskListTool, taskOutputTool, taskStopTool } from './task.js';
import { todoListTool } from './todoList.js';
import { toolSearchTool } from './toolSearch.js';
import { fail, type ToolContext, type ToolDef, type ToolResult } from './types.js';
import type { ToolAccess } from './access.js';
import { webFetchTool } from './webFetch.js';
import { webSearchTool } from './webSearch.js';
import { writeFileTool } from './write.js';

/** 全部工具，按注册顺序。 */
const ALL_TOOLS: ToolDef<any>[] = [
  { ...readFileTool, tier: 'core' },
  { ...readMediaTool, tier: 'core' },
  { ...writeFileTool, tier: 'core' },
  { ...editFileTool, tier: 'core' },
  { ...listDirTool, tier: 'core' },
  { ...globTool, tier: 'core' },
  { ...grepTool, tier: 'core' },
  { ...bashTool, tier: 'core' },
  { ...webSearchTool, tier: 'core' },
  { ...webFetchTool, tier: 'core' },
  { ...imageSearchTool, tier: 'core' },
  { ...spawnAgentTool, tier: 'core' },
  { ...exitPlanModeTool, tier: 'core' },
  { ...askUserTool, tier: 'core' },
  { ...todoListTool, tier: 'core' },
  { ...taskListTool, tier: 'core' },
  { ...taskOutputTool, tier: 'core' },
  { ...taskStopTool, tier: 'core' },
  { ...skillTool, tier: 'core' },
  { ...skillSearchTool, tier: 'core' },
  { ...createGoalTool, tier: 'core' },
  { ...updateGoalTool, tier: 'core' },
  { ...setGoalBudgetTool, tier: 'core' },
  { ...getGoalTool, tier: 'core' },
  { ...toolSearchTool, tier: 'core' },
  { ...teamInitTool, tier: 'experimental' },
  { ...teamPlanTool, tier: 'experimental' },
  { ...teamSpawnTool, tier: 'experimental' },
  { ...teamSendTool, tier: 'experimental' },
  { ...teamInboxTool, tier: 'experimental' },
  { ...teamStatusTool, tier: 'experimental' },
  { ...teamMergeTool, tier: 'experimental' },
  { ...teamTeardownTool, tier: 'experimental' },
  { ...dynamicWorkflowTool, tier: 'experimental' },
];

const TOOL_MAP = new Map<string, ToolDef<any>>(ALL_TOOLS.map((t) => [t.name, t]));

/** 动态注册的工具（如 MCP 懒加载命中的工具），运行期追加。 */
const DYNAMIC_TOOLS = new Map<string, ToolDef<any>>();

/** 动态注册一个工具（如 MCP 工具命中后加载）。同名覆盖。 */
export function registerDynamicTool(tool: ToolDef<any>): void {
  DYNAMIC_TOOLS.set(tool.name, tool);
}

/** 清空动态注册的工具（会话切换时）。 */
export function clearDynamicTools(): void {
  DYNAMIC_TOOLS.clear();
}

/**
 * 把工具返回的任意值规整为合法 ToolResult（信任边界）。
 * 工具若返回 undefined / 原始值 / 畸形对象，一律转成合成的 isError 结果，
 * 保证 agent 循环总能给每个 tool_use 配上一个 tool_result，绝不出现孤立 tool_use。
 */
export function coerceToolResult(value: unknown): ToolResult {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToolResult).content === 'string' &&
    typeof (value as ToolResult).isError === 'boolean'
  ) {
    return value as ToolResult;
  }
  if (typeof value === 'string') {
    return { content: value, isError: false };
  }
  return fail(`工具返回了非法结果（${typeof value}），已按错误处理。`);
}

/** 生成 Anthropic Messages API 的 tools 数组。传入 names 则只取白名单内的工具（供子 agent 收窄工具集）。 */
export function toAnthropicTools(
  names?: readonly string[],
  ctx?: { experimentalToolsEnabled?: boolean },
): Anthropic.Tool[] {
  const set = names === undefined ? undefined : new Set(names);
  // 动态工具并入，但若与静态工具同名（如覆盖注册）则不重复，以静态定义为准
  const dynamic = [...DYNAMIC_TOOLS.values()].filter((t) => !TOOL_MAP.has(t.name));
  const all = [...ALL_TOOLS, ...dynamic];
  const experimentalEnabled = ctx?.experimentalToolsEnabled === true;
  return all
    .filter((t) => {
      if (set !== undefined && !set.has(t.name)) return false;
      if (t.tier === 'experimental' && !experimentalEnabled) return false;
      return true;
    })
    .map((tool) => {
      const jsonSchema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
      delete jsonSchema['$schema'];
      return {
        name: tool.name,
        description: tool.description,
        input_schema: jsonSchema as Anthropic.Tool.InputSchema,
      };
    });
}

/** 全部已注册工具名（含动态注册）。 */
export function allToolNames(): string[] {
  return [...ALL_TOOLS.map((t) => t.name), ...DYNAMIC_TOOLS.keys()];
}

/**
 * 默认工具名列表：按 tier 过滤（core/advanced 始终暴露，experimental 需 ctx.experimentalToolsEnabled）。
 * 动态注册的工具（MCP 等）始终包含在默认列表中。
 * 当调用方未显式指定 allowedTools 时使用。
 */
export function defaultToolNames(ctx: { experimentalToolsEnabled?: boolean }): string[] {
  const experimental = ctx.experimentalToolsEnabled === true;
  const staticNames = ALL_TOOLS.filter((t) => t.tier !== 'experimental' || experimental).map((t) => t.name);
  const dynamicNames = [...DYNAMIC_TOOLS.keys()];
  return [...staticNames, ...dynamicNames];
}

/**
 * 为未知工具名生成「可用工具清单 + 近似候选」的恢复提示（G2）。
 *
 * 背景：此处原先是光秃秃的 `未知工具：X`，模型拿不到任何可用工具名，
 * 只能凭记忆再猜一个——跨回合重试因此可以无限循环（每次猜错都得到同一条无线索的消息）。
 * 本函数把「你猜错了」升级为「你猜错了，可选的是这些，你是不是想用那个」。
 *
 * 近似判定用编辑距离（Levenshtein）+ 子串包含两种信号，取距离最近者；
 * 命中阈值放宽到「距离 ≤ max(2, 名字长度/3)」是为了容忍 Flash 的常见拼写偏移
 * （漏一个下划线、少一个字母、复数形态），同时不至于把毫不相干的工具名凑成候选。
 *
 * @param name      模型给出的（未注册的）工具名
 * @param available 当前上下文实际可用的工具名清单
 * @returns 形如「未知工具：X。可用工具：a、b…。是否想用 nearest？」的单行提示
 */
export function unknownToolMessage(name: string, available: readonly string[]): string {
  const base = `未知工具：${name}。`;
  if (available.length === 0) {
    return `${base}当前上下文没有可用工具。`;
  }
  const nearest = nearestToolName(name, available);
  const list = `可用工具：${available.join('、')}。`;
  return nearest === undefined
    ? `${base}${list}`
    : `${base}${list}是否想用 nearest：${nearest}？`;
}

/** 在候选清单里找与 name 最接近的一个；无足够接近者返回 undefined。 */
function nearestToolName(name: string, available: readonly string[]): string | undefined {
  const target = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of available) {
    const lower = candidate.toLowerCase();
    // 子串包含直接认定（如模型写了 mcp__server__grep 而工具名是 grep）
    if (lower.includes(target) || target.includes(lower)) return candidate;
    if (Math.abs(lower.length - target.length) > 4) continue;
    const distance = levenshtein(lower, target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // 阈值随名字长度放宽：短名容 2，长名容 1/3
  const threshold = Math.max(2, Math.floor(target.length / 3));
  return bestDistance <= threshold ? best : undefined;
}

/** 经典编辑距离（滚动数组，O(min(a,b)) 空间）。 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/**
 * 取一次工具调用的资源访问声明（供 runTurn 并行调度冲突判定）。
 * 未知工具 / 未声明 / 入参非法一律按 all（独占串行，安全退化）。
 */
export function toolAccessOf(name: string, rawInput: unknown, ctx: ToolContext): ToolAccess {
  const tool = TOOL_MAP.get(name) ?? DYNAMIC_TOOLS.get(name);
  if (tool?.access === undefined) return { kind: 'all' };
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) return { kind: 'all' };
  return tool.access(parsed.data, ctx);
}

/**
 * 执行一次工具调用：校验入参 → 调用 execute。校验失败、未知工具、执行抛异常、
 * 返回畸形值——全部转为 ToolResult（错误以 isError 回灌），绝不抛出，
 * 以便 agent 循环把错误交还给模型自我纠正。
 *
 * 对 Step 3.7 Flash 等小模型做一次轻度容错：schema 校验失败时，尝试把常见格式错误
 * （字符串 "true"/"false" 转布尔、数值字符串转数字）修正后重试一次，不直接判死。
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = TOOL_MAP.get(name) ?? DYNAMIC_TOOLS.get(name);
  if (tool === undefined) {
    // 恢复提示用「按 tier 过滤后的实际可用集」，而非全量工具名：
    // 否则 experimental 关闭时会把 team_* 等隐藏工具宣传给模型，诱导它去调用一个它根本没有的工具。
    return fail(unknownToolMessage(name, defaultToolNames(ctx)));
  }
  let parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    const tolerant = tolerantParse(rawInput, tool.schema);
    if (tolerant.success) {
      parsed = tolerant;
    }
  }
  if (!parsed.success) {
    return fail(`工具 ${name} 入参校验失败：${parsed.error.message}`);
  }
  try {
    return coerceToolResult(await tool.execute(parsed.data, ctx));
  } catch (e) {
    return fail(`工具 ${name} 执行异常：${(e as Error).message}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 对 schema 校验失败的输入做一次轻度修正：只处理顶层字段的类型误判，
 * 把字符串 "true"/"false" 转布尔、数值字符串转数字，不改变语义。
 */
function tolerantParse(rawInput: unknown, schema: z.ZodTypeAny) {
  if (!isPlainObject(rawInput)) {
    return schema.safeParse(rawInput);
  }
  const original = schema.safeParse(rawInput);
  if (original.success) return original;

  const issues = original.error.issues;
  const coerced: Record<string, unknown> = { ...rawInput };
  let changed = false;

  for (const issue of issues) {
    if (issue.code !== 'invalid_type') continue;
    if (!issue.path || issue.path.length === 0) continue;
    const field = issue.path[0] as string;
    const currentValue = coerced[field];
    if (issue.expected === 'boolean' && typeof currentValue === 'string') {
      if (currentValue === 'true') {
        coerced[field] = true;
        changed = true;
      } else if (currentValue === 'false') {
        coerced[field] = false;
        changed = true;
      }
    } else if (issue.expected === 'number' && typeof currentValue === 'string') {
      const num = Number(currentValue);
      if (!isNaN(num)) {
        coerced[field] = num;
        changed = true;
      }
    }
  }

  if (!changed) return original;
  return schema.safeParse(coerced);
}
