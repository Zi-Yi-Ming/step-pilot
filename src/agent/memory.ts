/**
 * memory：agent 自主维护的观察池（markdown 目录）。
 *
 * 定位：观察池，不是直接生效的记忆层。agent 写入的观察未经用户确认不视为约束；
 * 定期回顾后经确认才晋升到用户自维护的规范层（AGENTS.md、skills 等）。
 *
 * 本模块只有**读侧**：扫描、解析、索引、system 段。写侧刻意不做专用工具——
 * agent 用既有 write_file / edit_file 直接维护记忆文件（轻量方向：不引入提取管线）。
 *
 * 存储两级：全局 <home>/.step-pilot/memory/ 与项目 <cwd>/.step-pilot/memory/，
 * 同主题（相对路径相同）时项目层优先——局部约定覆盖全局习惯，与 git config 语义一致。
 *
 * 文件格式：markdown 正文 + HTML 注释藏 JSON 字段（人可读可手改，机器可解析）：
 *
 *   # 主题
 *   正文……
 *   <!-- MEMORY_FIELDS
 *   {"type": "project", "version": 2, "occurrences": 2, "created_at": "...", "updated_at": "..."}
 *   -->
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

/** 单条记忆观察。 */
export interface MemoryEntry {
  /** 层级：全局 / 项目。同 relPath 时项目层优先。 */
  scope: 'global' | 'project';
  /** 主题：文件首个 `# ` 标题；无标题退化为文件名。 */
  topic: string;
  /** 一句话摘要：正文首个非空行（截断）。 */
  summary: string;
  /** 相对 memory 根的路径（POSIX 分隔，如 `project/package-manager.md`）。 */
  relPath: string;
  /** 绝对路径（给 read/grep 用，也展示给用户）。 */
  absPath: string;
  /** 「第 N 次出现」计数（MEMORY_FIELDS.occurrences，缺省 1）。 */
  occurrences: number;
  /** 写入版本（MEMORY_FIELDS.version，缺省 1）。 */
  version: number;
  /** 最后更新时间（MEMORY_FIELDS.updated_at，缺省文件 mtime）。 */
  updatedAt: string;
  /** true = 解析失败（缺注释块或 JSON 损坏）：不进索引、不阻塞，/memory 列为待修复。 */
  broken: boolean;
}

export interface MemoryScan {
  entries: MemoryEntry[];
  /** 解析失败的文件（仍列出，供 /memory 提示用户修复）。 */
  broken: MemoryEntry[];
}

/** MEMORY_FIELDS 注释块：非贪婪匹配花括号 JSON，允许多行。 */
const FIELDS_RE = /<!--\s*MEMORY_FIELDS\s*(\{[\s\S]*?\})\s*-->/;

const SUMMARY_MAX = 60;

/** 截断到 max 字符（超出加省略号）。 */
function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * 解析单个记忆文件。
 * 坏文件（读不了、JSON 损坏）返回 broken 条目而不是抛错——记忆是辅助设施，
 * 一个手滑写坏的文件不能阻塞主流程。
 */
export function parseMemoryFile(absPath: string, relPath: string, scope: 'global' | 'project'): MemoryEntry {
  const base: MemoryEntry = {
    scope,
    topic: relPath.replace(/\.md$/i, ''),
    summary: '',
    relPath,
    absPath,
    occurrences: 1,
    version: 1,
    updatedAt: '',
    broken: false,
  };
  let text: string;
  try {
    text = readFileSync(absPath, 'utf-8');
  } catch {
    return { ...base, broken: true };
  }
  try {
    base.updatedAt = statSync(absPath).mtime.toISOString();
  } catch {
    // mtime 拿不到就留空，不算坏文件
  }

  // 主题：首个 `# ` 标题
  const titleMatch = text.match(/^#\s+(.+)$/m);
  if (titleMatch) base.topic = titleMatch[1]!.trim();

  // 摘要：正文里首个非空、非标题、非注释块的行
  const bodyWithoutFields = text.replace(FIELDS_RE, '');
  for (const line of bodyWithoutFields.split('\n')) {
    const s = line.trim();
    if (s === '' || s.startsWith('#')) continue;
    base.summary = clip(s, SUMMARY_MAX);
    break;
  }

  // 结构化字段（缺注释块不算坏：用户手写的新文件可能还没加；JSON 损坏才算坏）
  const fieldsMatch = text.match(FIELDS_RE);
  if (fieldsMatch) {
    try {
      const fields = JSON.parse(fieldsMatch[1]!) as Record<string, unknown>;
      if (typeof fields['version'] === 'number') base.version = fields['version'];
      if (typeof fields['occurrences'] === 'number') base.occurrences = fields['occurrences'];
      if (typeof fields['updated_at'] === 'string') base.updatedAt = fields['updated_at'];
    } catch {
      return { ...base, broken: true };
    }
  }
  return base;
}

/** 递归收集目录下的 .md 文件（跳过隐藏目录与 node_modules）。 */
function collectMdFiles(dir: string, root: string, out: string[]): void {
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      collectMdFiles(full, root, out);
    } else if (item.isFile() && item.name.toLowerCase().endsWith('.md')) {
      out.push(relative(root, full).split(sep).join('/'));
    }
  }
}

/** 扫一层记忆目录（不存在返回空）。 */
function scanLayer(root: string, scope: 'global' | 'project'): { entries: MemoryEntry[]; broken: MemoryEntry[] } {
  const entries: MemoryEntry[] = [];
  const broken: MemoryEntry[] = [];
  if (!existsSync(root)) return { entries, broken };
  const files: string[] = [];
  collectMdFiles(root, root, files);
  for (const rel of files) {
    const entry = parseMemoryFile(join(root, rel), rel, scope);
    (entry.broken ? broken : entries).push(entry);
  }
  return { entries, broken };
}

/**
 * 扫描两层记忆目录并合并。同 relPath 时项目层覆盖全局层（局部约定优先）。
 * 结果按 updatedAt 倒序（最近更新的在前——回顾时最活跃的观察最先被看到）。
 */
export function scanMemory(cwd: string, home: string = homedir()): MemoryScan {
  const globalLayer = scanLayer(join(home, '.step-pilot', 'memory'), 'global');
  const projectLayer = scanLayer(join(cwd, '.step-pilot', 'memory'), 'project');

  const merged = new Map<string, MemoryEntry>();
  for (const e of globalLayer.entries) merged.set(e.relPath, e);
  for (const e of projectLayer.entries) merged.set(e.relPath, e); // 项目层后写，覆盖同 relPath 的全局层

  const entries = [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { entries, broken: [...globalLayer.broken, ...projectLayer.broken] };
}

/** 索引单条行，如：`- [project] 包管理器 — 用户纠正过：用 pnpm（第 2 次出现）（project/package-manager.md）` */
function indexLine(e: MemoryEntry): string {
  const recur = e.occurrences > 1 ? ` (seen ${e.occurrences} times)` : '';
  const summary = e.summary === '' ? '' : ` — ${e.summary}`;
  return `- [${e.scope}] ${e.topic}${summary}${recur} (${e.relPath})`;
}

/** 索引字符预算：超出截断并标注省略条数（与 subagent listing 同一手法）。 */
export const MEMORY_INDEX_BUDGET = 1500;

/** 索引实际字符用量（/memory 展示用，与 memorySection 的截断口径一致）。 */
export function measureMemoryIndex(scan: MemoryScan): number {
  let used = 0;
  for (const e of scan.entries) {
    const line = indexLine(e);
    if (used + line.length + 1 > MEMORY_INDEX_BUDGET) break;
    used += line.length + 1;
  }
  return used;
}

/** /memory 列表的单条展示行（给人看，含路径与更新时间）。 */
export function formatMemoryEntryLine(e: MemoryEntry): string {
  const recur = e.occurrences > 1 ? `（第 ${e.occurrences} 次出现）` : '';
  const date = e.updatedAt === '' ? '' : ` · ${e.updatedAt.slice(0, 10)}`;
  const summary = e.summary === '' ? '' : ` — ${e.summary}`;
  return `  - ${e.topic}${summary}${recur}${date}\n    ${e.absPath}`;
}

/**
 * 生成 system 尾部的记忆段。entries 为空时也返回段（含写入引导）——
 * 空目录正是最需要引导 agent 开始积累的时刻。
 *
 * readonly 变体（子 agent 用）：有目录说明与索引，但无写入引导——
 * 子 agent 是临时上下文且并行写会产生 version 冲突；它发现值得记的事，
 * 应写进返回报告，由主 agent 决定写不写。
 */
export function memorySection(scan: MemoryScan, mode: 'full' | 'readonly' = 'full'): string {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const e of scan.entries) {
    const line = indexLine(e);
    if (used + line.length + 1 > MEMORY_INDEX_BUDGET) {
      omitted++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const indexPart =
    lines.length === 0
      ? '  (no observations yet)'
      : lines.map((l) => `  ${l}`).join('\n') + (omitted > 0 ? `\n  (${omitted} more omitted for brevity; run \`/memory\` for the full list)` : '');
  return `## Memory
- You have two long-term memory directories: global ~/.step-pilot/memory/ (cross-project preference observations) and project .step-pilot/memory/ (project-specific conventions).
- These are your own accumulated observations. Unconfirmed by the user, they are not constraints. You may reference them (for example, to avoid repeating corrected mistakes), but if they conflict with confirmed specs such as AGENTS.md, follow the spec.
- Current index:
${indexPart}
- The index is summary-only. Before working on something potentially relevant, read the corresponding file; you can also grep the memory directory for full text.
${mode === 'readonly' ? `- You are a subagent: memory is read-only. Write findings into your return report; the primary agent decides whether to persist them; do not write to the memory directory directly.` : `- Write or update observations (with write_file / edit_file; markdown body plus a \`<!-- MEMORY_FIELDS {...} -->\` comment carrying version/occurrences/updated_at) when the user explicitly asks to remember something, the user corrects you, you identify a stable project convention, or you discover corrected points at task closure. When the same observation recurs, only bump occurrences; keep the text unchanged.
- One-shot task context, facts readable from code/config, and unverified guesses are not recorded.`}`;
}

/** /memory on 中途开启时的回看引导（注入 messages，origin: injection）。 */
export const MEMORY_ONBOARDING_INJECTION =
  'Memory is now enabled. Memory directories: ~/.step-pilot/memory/ and .step-pilot/memory/.\n' +
  'Review the conversation so far: if there were cases of "user corrected you", "user explicitly asked to remember", or "recurring conventions", backfill them now; otherwise you can skip this. After this, continue normal memory accumulation as described in system.';
