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
    return fail(`未知工具：${name}`);
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
