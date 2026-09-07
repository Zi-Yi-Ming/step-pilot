import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentDefinition } from './types.js';

const MIN_PROMPT_LEN = 20;

/** 内置角色。general = 全能（工具全集，运行时剔除 spawn_agent）；explore = 只读。maxSteps 留空 → 用 config 全局默认。 */
const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: 'general',
    description: 'General-purpose subagent: can read/write files, execute commands, and search. Suitable for delegating relatively independent subtasks that need hands-on changes.',
    whenToUse: 'Use for hands-on subtasks: code changes, running build/tests, multi-step implementation. Prefer it when the task scope is clear and can be completed independently.',
    tools: undefined, // all tools except spawn_agent (removed at runtime)
    systemPrompt: `You are a general-purpose subagent spawned by the primary agent. Complete the assigned subtask independently.
You cannot see the primary agent's conversation history; all necessary context is in your task description.

Result contract: your tool-call process is invisible to the primary agent; only your final summary returns. Be concise: what you did, conclusions, and which files changed. Include full key paths so the primary agent can continue without re-locating.

Work discipline:
- Minimal changes; read related files first.
- If the task clearly exceeds its stated scope (missing prerequisites, unforeseen modules): report what is blocking and what is missing; do not fabricate or expand scope on your own.
- If you have spawn_agent, apply the same delegation discipline: only delegate when a subtask is truly independent and substantial; do not repackage trivial steps.`,
  },
  {
    name: 'explore',
    description: 'Read-only exploration subagent: searches the codebase, reads files, looks up online resources, and summarizes findings. Does not modify any files; suitable for investigation, localization, and research.',
    whenToUse: 'Use for large-scale retrieval or thorough investigation: understand how a mechanism works, locate a bug, collect references. Multiple independent questions can be dispatched in the same round and run in parallel.',
    tools: ['read_file', 'read_media', 'list_dir', 'glob', 'grep', 'web_search', 'web_fetch', 'web_image_search', 'skill'],
    systemPrompt: `You are a read-only exploration subagent spawned by the primary agent. You can only read, search, and look up information; you cannot modify files or execute commands.
You cannot see the primary agent's conversation history; all necessary context is in your task description.

Result contract: your search process is invisible to the primary agent; only your final summary returns. Provide concrete file paths and line numbers so the primary agent can locate issues directly without re-searching.

Reporting discipline:
- Lead with conclusions, then provide supporting evidence (paths, line numbers, key code snippets).
- If you cannot find something, say so explicitly: state where you looked, what keywords you used, and that the result is "not found". Do not fabricate or fill gaps with guesses.
- Distinguish "the code actually does this" from "I inferred this from ..."; the latter must be labeled as inference.`,
  },
];

/** 解析一份 agent markdown（YAML frontmatter + 正文）。非法返回 null。 */
export function parseAgentMarkdown(content: string, fallbackName: string): AgentDefinition | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (m === null) return null;
  let fm: Record<string, unknown>;
  try {
    fm = (parseYaml(m[1]!) as Record<string, unknown>) ?? {};
  } catch {
    return null;
  }
  const body = (m[2] ?? '').trim();
  const name = typeof fm['name'] === 'string' && fm['name'].length > 0 ? fm['name'] : fallbackName;
  const description = typeof fm['description'] === 'string' ? fm['description'] : '';
  if (name.length === 0 || description.length === 0 || body.length < MIN_PROMPT_LEN) {
    return null; // 缺 name/description 或正文过短 → 视为非 agent 文件，跳过
  }
  const toolsRaw = fm['tools'];
  const tools = Array.isArray(toolsRaw) ? toolsRaw.map(String) : undefined;
  // whenToUse 兼容驼峰与蛇形两种写法（蛇形与 skill 的 when_to_use 命名习惯对齐）
  const whenToUseRaw = fm['whenToUse'] ?? fm['when_to_use'];
  const whenToUse =
    typeof whenToUseRaw === 'string' && whenToUseRaw.trim().length > 0
      ? whenToUseRaw.trim()
      : undefined;
  // maxSteps 未配或非法 → undefined，交给 config 全局默认兜底
  const maxSteps =
    typeof fm['maxSteps'] === 'number' && fm['maxSteps'] > 0 ? fm['maxSteps'] : undefined;
  return {
    name,
    description,
    whenToUse,
    tools,
    model: typeof fm['model'] === 'string' ? fm['model'] : undefined,
    maxSteps,
    systemPrompt: body,
  };
}

function loadAgentsFromDir(dir: string): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  const out: AgentDefinition[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    try {
      const def = parseAgentMarkdown(readFileSync(join(dir, file), 'utf8'), file.replace(/\.md$/, ''));
      if (def !== null) out.push(def);
    } catch {
      // 跳过损坏文件
    }
  }
  return out;
}

/**
 * 构建 agent 注册表：内置 < 用户(~/.step-pilot/agents) < 项目(<cwd>/.step-pilot/agents)，同名后者覆盖。
 */
export function buildAgentRegistry(cwd: string): Map<string, AgentDefinition> {
  const registry = new Map<string, AgentDefinition>();
  for (const def of BUILTIN_AGENTS) registry.set(def.name, def);
  for (const def of loadAgentsFromDir(join(homedir(), '.step-pilot', 'agents'))) {
    registry.set(def.name, def);
  }
  for (const def of loadAgentsFromDir(join(cwd, '.step-pilot', 'agents'))) {
    registry.set(def.name, def);
  }
  return registry;
}
