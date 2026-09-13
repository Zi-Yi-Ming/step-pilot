/**
 * Reliability dashboard —— 把散落的 benchmark 结果聚合成「可靠性仪表盘」。
 *
 * 定位（见 .agent-memory/project-positioning-successor-line.md）：
 * 可靠性是本项目唯一的对外卖点，因此需要一枚可被外部核验的数字。本模块是
 * 「benchmark 基础设施 → 每晚可靠性仪表盘」的最后一环：runner 产出单次结果、
 * reporter 产出单次报告，本模块负责**跨多次运行聚合**，给出四条头条指标：
 *
 *   1. 成功率（success rate）
 *   2. 平均 token 消耗（mean total tokens）
 *   3. 空响应率（empty-response rate）—— Step 三协议实测 `reasoning_tokens` 恒为 0，
 *      思考耗尽预算导致的空响应是本项目最典型的不报错故障，必须单列
 *   4. 工具泄漏率（tool-leak rate）—— 模型把工具调用打成纯文本，工具从未执行
 *
 * 设计原则：
 * - **纯函数 + 只读 IO 边界**：核心 `aggregateRuns()` 不碰文件系统，便于单测；
 *   `loadRunFiles()` 是唯一的读盘入口。
 * - **不修改 runner / reporter**：两者已各自可用，本模块只做消费方。
 * - **不伪装成因果**：只输出描述性统计（率、均值、中位数、分布），
 *   不写「提升了 X%」这类需要对照组才能成立的结论。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkReport, RunResult } from './types.js';

/* ------------------------------------------------------------------ */
/* 类型                                                               */
/* ------------------------------------------------------------------ */

/** 一组运行（通常 = 同一 profile 的全部 run）聚合出的指标。 */
export interface DashboardMetrics {
  /** 参与聚合的运行数。 */
  runs: number;
  /** 成功运行数。 */
  successes: number;
  /** 成功率 = successes / runs。 */
  success_rate: number;
  /** 空响应运行数（stop_reason / failure_reason 指向空响应或思考耗尽）。 */
  empty_responses: number;
  /** 空响应率。 */
  empty_response_rate: number;
  /** 工具调用泄漏运行数。 */
  tool_leaks: number;
  /** 工具泄漏率。 */
  tool_leak_rate: number;
  /** 平均总 token。 */
  mean_total_tokens: number;
  /** 总 token 中位数。 */
  median_total_tokens: number;
  /** 平均回合数。 */
  mean_turns: number;
  /** 平均工具调用数。 */
  mean_tool_calls: number;
  /** 平均工具错误数。 */
  mean_tool_errors: number;
  /** 平均重试数。 */
  mean_retries: number;
  /** 平均压缩次数。 */
  mean_compactions: number;
  /** 平均耗时（ms）。 */
  mean_duration_ms: number;
  /** 超时运行数（failure_reason 含 timeout）。 */
  timeouts: number;
  /**
   * 命中评测框架故障的运行数（`harness_error !== null`）。
   *
   * 为什么要单列成一个头条口径：这些运行的失败**与模型能力无关**，
   * 但仍会被算进 `runs`（于是拉低 success_rate）。不单列的话，
   * 一次「测试文件被误删」的框架 bug 会被读成模型能力下降——
   * 本仓真实发生过（见 benchmark/HARNESS-AUDIT.md D1，实测把所有任务钉在失败）。
   *
   * 口径：`harness_broken + (runs - harness_broken)`，即「不可信的运行」与「可信的」。
   * 报数时应报 `success_rate` 并同时给出 `harness_broken`，让读者知道分母里有多少是坏的。
   */
  harness_broken: number;
  /** 框架故障率 = harness_broken / runs。 */
  harness_broken_rate: number;
  /** agent 未发出成功终态、因此 verify 被跳过的运行数。 */
  verification_skipped: number;
  /** verification_skipped / runs。 */
  verification_skipped_rate: number;
  /** 各失败归因计数。 */
  failure_taxonomy: Record<string, number>;
}

/** 按 profile 分组的聚合结果。 */
export interface DashboardGroup extends DashboardMetrics {
  /** profile 名（如 full / ablation）。 */
  profile: string;
  /** 该组覆盖的任务 id。 */
  tasks: string[];
  /** 该组覆盖的模型（多模型混入时取并集）。 */
  models: string[];
  /** 最早 / 最新的运行时间戳（若结果文件带 timestamp）。 */
  first_seen?: string;
  last_seen?: string;
}

/** 完整仪表盘数据。 */
export interface Dashboard {
  /** 生成时间（ISO）。 */
  generated_at: string;
  /** 扫描的结果文件数。 */
  source_files: number;
  /** 参与聚合的总运行数。 */
  total_runs: number;
  /** 全量（不分 profile）聚合。 */
  overall: DashboardMetrics;
  /** 按 profile 分组。 */
  by_profile: DashboardGroup[];
  /** 按任务分组（便于定位「哪个任务在退化」）。 */
  by_task: Array<DashboardMetrics & { task_id: string }>;
}

/* ------------------------------------------------------------------ */
/* 判据                                                               */
/* ------------------------------------------------------------------ */

/**
 * 空响应判据。
 *
 * 三种来源都要覆盖（顺序即优先级）：
 * - `stop_reason === 'thinking_exhausted'` —— 思考吃满预算、正文零输出（最典型）
 * - `stop_reason === 'max_tokens'` 且 output_tokens 极低 —— 正文被截断到几乎为零
 * - `failure_reason` 文本含空响应特征（上游 turn.issue kind='empty' 落下的文案）
 *
 * 不用「output_tokens < N 即异常」这类阈值：合法短答（问 1+1 答 2）输出天然极少，
 * 唯一能区分合法短答与空响应的信息是任务复杂度，客户端拿不到。
 */
const EMPTY_REASON_PATTERN = /empty|空响应|thinking[_ ]exhausted|思考.*耗尽|max_tokens/i;

export function isEmptyResponse(run: RunResult): boolean {
  if (run.stop_reason === 'thinking_exhausted') return true;
  if (run.stop_reason === 'max_tokens' && run.output_tokens <= 0) return true;
  const reason = run.failure_reason ?? '';
  if (reason === '') return false;
  return EMPTY_REASON_PATTERN.test(reason);
}

/**
 * 工具泄漏判据。
 *
 * runner 目前不单列该字段，因此从**事件流**里找：工具泄漏在 stream-json 里表现为
 * 模型正文中出现工具调用标签（`<invoke name=` / `<function_calls>` 等）。
 *
 * 判据刻意只匹配**尖括号标签形态**，不匹配裸词——理由见 AGENTS.md
 * 「工具调用泄漏检测的判据是尖括号标签，别优化回裸词」：这些裸词字面就写在本仓
 * 与产品设计文档里，「读文档并复述」是本项目 agent 最常做的事，用裸词会误报。
 */
const LEAK_TAG_PATTERN = /<(?:antml:)?(?:invoke|function_calls|parameter)\b/i;

export function hasToolLeak(run: RunResult): boolean {
  for (const ev of run.events ?? []) {
    const text = extractText(ev);
    if (text !== undefined && LEAK_TAG_PATTERN.test(text)) return true;
  }
  return false;
}

/** 从一条原始事件里尽量取出可读文本（text / message / result / content 字段）。 */
function extractText(ev: { type: string; [key: string]: unknown }): string | undefined {
  for (const key of ['text', 'message', 'result', 'content']) {
    const v = ev[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 聚合                                                               */
/* ------------------------------------------------------------------ */

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 取一个数值字段，缺失/非数一律当 0。
 *
 * 这不是旧格式兼容，而是结果目录的**外部输入容错**：结果文件由不同版本的 runner
 * 写入，也可能被人手编辑，个别字段缺失不应让整张仪表盘变成 NaN。
 */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** 归因一条失败运行的类别（与 reporter 的 classifyFailure 同口径）。 */
function classifyFailure(run: RunResult): string {
  if (run.success) return 'none';
  // 框架故障优先判：它的成因在评测侧，不是模型行为。
  // 放在最前是因为后续判据（timeout/loop/test_failure）都可能被框架故障的
  // 表象误命中——例如「测试文件被删」会因 exit!=0 被读成 test_failure。
  if (run.verification_skipped === true) return 'verification_skipped';
  if ((run.harness_error ?? null) !== null) return 'harness_verify_error';
  if (isEmptyResponse(run)) return 'empty_response';
  if (run.failure_reason?.includes('timeout')) return 'timeout';
  if (hasToolLeak(run)) return 'tool_leak';
  if (run.tool_errors > 0 && run.retries > 0) return 'tool_call';
  if (run.compactions > 0 && run.total_tokens > 200_000) return 'compaction';
  if (run.failure_reason?.includes('context') || run.failure_reason?.includes('overflow')) return 'context';
  if (run.retries > 2) return 'loop';
  if (run.failure_reason?.includes('test')) return 'test_failure';
  if (run.failure_reason) return 'other';
  return 'unknown';
}

/** 把一组运行聚合成指标。纯函数。 */
export function aggregateRuns(runs: RunResult[]): DashboardMetrics {
  const total = runs.length;
  const successes = runs.filter((r) => r.success).length;
  const emptyRuns = runs.filter(isEmptyResponse).length;
  const leakRuns = runs.filter(hasToolLeak).length;
  const timeouts = runs.filter((r) => r.failure_reason?.includes('timeout')).length;
  // 框架故障单列：这类失败的成因在评测侧，不反映模型能力。
  const harnessBroken = runs.filter((r) => (r.harness_error ?? null) !== null).length;
  const verificationSkipped = runs.filter((r) => r.verification_skipped === true).length;

  const taxonomy: Record<string, number> = {};
  for (const r of runs) {
    const key = classifyFailure(r);
    taxonomy[key] = (taxonomy[key] ?? 0) + 1;
  }

  const rate = (n: number) => (total === 0 ? 0 : n / total);
  const round1 = (v: number) => Math.round(v * 10) / 10;

  return {
    runs: total,
    successes,
    success_rate: rate(successes),
    empty_responses: emptyRuns,
    empty_response_rate: rate(emptyRuns),
    tool_leaks: leakRuns,
    tool_leak_rate: rate(leakRuns),
    mean_total_tokens: Math.round(mean(runs.map((r) => num(r.total_tokens)))),
    median_total_tokens: Math.round(median(runs.map((r) => num(r.total_tokens)))),
    mean_turns: round1(mean(runs.map((r) => num(r.turns)))),
    mean_tool_calls: round1(mean(runs.map((r) => num(r.tool_calls)))),
    mean_tool_errors: round1(mean(runs.map((r) => num(r.tool_errors)))),
    mean_retries: round1(mean(runs.map((r) => num(r.retries)))),
    mean_compactions: round1(mean(runs.map((r) => num(r.compactions)))),
    mean_duration_ms: Math.round(mean(runs.map((r) => num(r.duration_ms)))),
    timeouts,
    harness_broken: harnessBroken,
    harness_broken_rate: rate(harnessBroken),
    verification_skipped: verificationSkipped,
    verification_skipped_rate: rate(verificationSkipped),
    failure_taxonomy: taxonomy,
  };
}

/** 从多个报告里聚合出完整仪表盘。纯函数。 */
export function buildDashboard(reports: BenchmarkReport[], now: Date = new Date()): Dashboard {
  const allRuns: RunResult[] = [];
  for (const rep of reports) {
    for (const r of rep.results ?? []) allRuns.push(r);
  }

  // 按 profile 分组
  const grouped = new Map<string, RunResult[]>();
  for (const r of allRuns) {
    const key = r.profile ?? 'unknown';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  const by_profile: DashboardGroup[] = [];
  for (const [profile, runs] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    by_profile.push({
      profile,
      ...aggregateRuns(runs),
      tasks: [...new Set(runs.map((r) => r.task_id))].sort(),
      models: [...new Set(runs.map((r) => r.model))].sort(),
    });
  }

  // 按任务分组
  const byTask = new Map<string, RunResult[]>();
  for (const r of allRuns) {
    const key = r.task_id ?? 'unknown';
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key)!.push(r);
  }
  const by_task = [...byTask.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([task_id, runs]) => ({ task_id, ...aggregateRuns(runs) }));

  return {
    generated_at: now.toISOString(),
    source_files: reports.length,
    total_runs: allRuns.length,
    overall: aggregateRuns(allRuns),
    by_profile,
    by_task,
  };
}

/* ------------------------------------------------------------------ */
/* 读盘（唯一 IO 边界）                                                */
/* ------------------------------------------------------------------ */

/**
 * 读取一个目录下的全部 benchmark 结果 JSON。损坏/非报告文件静默跳过——
 * 这是容错而非旧格式兼容：结果目录是人工可写的外部输入，中途写入的半截文件
 * （CI 被杀）不能让整个仪表盘失效。
 */
export function loadRunFiles(dir: string): BenchmarkReport[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const reports: BenchmarkReport[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as BenchmarkReport;
      // 形状校验：必须有 results 数组，否则不是结果文件（如目录里混入其他 json）
      if (!Array.isArray(parsed?.results)) continue;
      reports.push(parsed);
    } catch {
      continue;
    }
  }
  return reports;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                               */
/* ------------------------------------------------------------------ */

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** 渲染为 Markdown 仪表盘（供 CI 日志 / 周报使用）。 */
export function renderDashboardMd(d: Dashboard): string {
  const lines: string[] = [
    '# Step Pilot · 可靠性仪表盘',
    '',
    `- 生成时间：${d.generated_at}`,
    `- 数据来源：${d.source_files} 个结果文件 / ${d.total_runs} 次运行`,
    '',
    '## 头条指标（全量）',
    '',
    '| 指标 | 值 |',
    '|------|-----|',
    `| 成功率 | ${pct(d.overall.success_rate)} (${d.overall.successes}/${d.overall.runs}) |`,
    `| 平均 token | ${d.overall.mean_total_tokens}（中位 ${d.overall.median_total_tokens}） |`,
    `| 空响应率 | ${pct(d.overall.empty_response_rate)} (${d.overall.empty_responses}) |`,
    `| 工具泄漏率 | ${pct(d.overall.tool_leak_rate)} (${d.overall.tool_leaks}) |`,
    `| 框架故障 | ${pct(d.overall.harness_broken_rate)} (${d.overall.harness_broken}/${d.overall.runs}) |`,
    `| 未执行验证 | ${pct(d.overall.verification_skipped_rate)} (${d.overall.verification_skipped}/${d.overall.runs}) |`,
  ];

  // 框架故障非零时给一句显式警告——这是防止「环境坏了」被读成「模型差了」的最后一道闸。
  if (d.overall.harness_broken > 0) {
    lines.push(
      '',
      `> **注意**：${d.overall.harness_broken} 次运行的失败成因在评测框架侧，与模型能力无关。`,
      '> 这些运行已被计入上面的分母，读数时请自行扣减。详见 `benchmark/HARNESS-AUDIT.md`。',
    );
  }

  lines.push(
    '',
    '## 按 profile',
    '',
    '| Profile | 运行 | 成功率 | 空响应率 | 泄漏率 | 框架故障 | 平均 token | 平均回合 |',
    '|---------|------|--------|----------|--------|----------|------------|----------|',
  );
  for (const g of d.by_profile) {
    lines.push(
      `| ${g.profile} | ${g.runs} | ${pct(g.success_rate)} | ${pct(g.empty_response_rate)} | ${pct(g.tool_leak_rate)} | ${g.harness_broken} | ${g.mean_total_tokens} | ${g.mean_turns} |`,
    );
  }

  lines.push('', '## 按任务', '', '| 任务 | 运行 | 成功率 | 空响应率 | 泄漏率 | 框架故障 | 平均 token |', '|------|------|--------|----------|--------|----------|------------|');
  for (const t of d.by_task) {
    lines.push(
      `| ${t.task_id} | ${t.runs} | ${pct(t.success_rate)} | ${pct(t.empty_response_rate)} | ${pct(t.tool_leak_rate)} | ${t.harness_broken} | ${t.mean_total_tokens} |`,
    );
  }

  lines.push('', '## 失败归因（全量）', '', '| 类别 | 次数 |', '|------|------|');
  for (const [k, v] of Object.entries(d.overall.failure_taxonomy).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push('', '> 描述性统计，不声称因果。', '');
  return lines.join('\n');
}

/** 渲染为 shields.io 徽章 URL（成功率）。 */
export function badgeUrl(d: Dashboard, style = 'flat-square'): string {
  const successPct = Number((d.overall.success_rate * 100).toFixed(1));
  // shields.io 的静态徽章接口；颜色按成功率三档
  const color = successPct >= 80 ? 'brightgreen' : successPct >= 50 ? 'yellow' : 'red';
  const label = encodeURIComponent('reliability');
  const value = encodeURIComponent(`${successPct}% success`);
  return `https://img.shields.io/badge/${label}-${value}-${color}?style=${style}`;
}
