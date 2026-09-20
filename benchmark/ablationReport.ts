/**
 * ablation 分析层：把 full / ablation 两个 profile 的跑批结果变成 Δ 指标。
 *
 * ## 为什么单独一个模块
 *
 * 核心命题是**对比命题**（"配上 harness 能走多远"），所以只看单一 profile 的成功率
 * 回答不了任何问题——必须成对比较。而 dashboard 聚合的是「一轮里所有 run」，
 * 天然会把两个 profile 混在一起，看不出对照。
 *
 * ## 三条纪律
 *
 * 1. **harness 故障单独计数、不进成功率分母**。环境坏掉的 run 不是模型失败，
 *    混进去就是 D1 的老毛病。但分母规则必须显式——剔除与不剔除会得出不同数字，
 *    所以这里两套都给，由报告写清楚用了哪套。
 * 2. **样本不足不出定量结论**。Wilson 95% CI 半宽超过阈值时，报告里明确标注
 *    「不足以支撑定量表述」，而不是给一个看起来很准的百分比。
 * 3. **原始数据可复算**。所有聚合都是纯函数，输入就是结果 JSON 里的 results 数组。
 */
import type { RunResult } from './types.js';

/** 单条臂（一个 profile 在一个任务上的全部 run）的统计。 */
export interface ArmStats {
  runs: number;
  /** 计入成功率的 run 数（剔除 harness 故障后）。 */
  scoredRuns: number;
  successes: number;
  successRate: number;
  /** Wilson 95% 置信区间（成功率）。 */
  ci: [number, number];
  /** CI 半宽；超过 {@link CI_HALF_WIDTH_MAX} 时不得对外定量表述。 */
  ciHalfWidth: number;
  avgTurns: number;
  avgToolCalls: number;
  avgDurationMs: number;
  avgTokens: number;
  /** 环境故障 run 数——单独计数，不进分母。 */
  harnessErrorRuns: number;
}

export interface AblationRow {
  task_id: string;
  full: ArmStats;
  ablation: ArmStats;
  /** full − ablation。正数表示 harness 有正贡献。 */
  delta: {
    successRate: number;
    avgTurns: number;
    avgDurationMs: number;
  };
}

export interface AblationReport {
  rows: AblationRow[];
  overall: AblationRow;
  /** 是否有任何一条臂的 CI 半宽超限（→ 整体只能作方向性参考）。 */
  anyInsufficient: boolean;
}

/** CI 半宽上限（百分点）。超过则不做对外定量表述。 */
export const CI_HALF_WIDTH_MAX = 0.15;

/** Wilson score 区间（二项比例）。比正态近似在小样本下更诚实。 */
function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 纯函数：一组 run → 一条臂的统计。 */
export function computeArm(results: readonly RunResult[]): ArmStats {
  // 只认「显式写成的 harness_error 字符串」。
  // 不用 `r.harness_error !== null`：字段缺失时 undefined !== null 为真，
  // 会让忘记写这个字段的代码路径把 run 静默剔出分母——那是与「静默计入」
  // 方向相反、同样危险的反向污染。宁可显式判空，让缺失落回「模型失败」侧，
  // 再由 runner 保证字段总被写上。
  const isHarnessError = (r: RunResult): boolean => typeof r.harness_error === 'string' && r.harness_error !== '';
  const harnessErrorRuns = results.filter(isHarnessError).length;
  const scored = results.filter((r) => !isHarnessError(r));
  const successes = scored.filter((r) => r.success).length;
  const [lo, hi] = wilson(successes, scored.length);
  return {
    runs: results.length,
    scoredRuns: scored.length,
    successes,
    successRate: scored.length === 0 ? 0 : successes / scored.length,
    ci: [lo, hi],
    ciHalfWidth: (hi - lo) / 2,
    avgTurns: mean(scored.map((r) => r.turns)),
    avgToolCalls: mean(scored.map((r) => r.tool_calls)),
    avgDurationMs: mean(scored.map((r) => r.duration_ms)),
    avgTokens: mean(scored.map((r) => r.total_tokens)),
    harnessErrorRuns,
  };
}

function row(taskId: string, full: RunResult[], ablation: RunResult[]): AblationRow {
  const f = computeArm(full);
  const a = computeArm(ablation);
  return {
    task_id: taskId,
    full: f,
    ablation: a,
    delta: {
      successRate: f.successRate - a.successRate,
      avgTurns: f.avgTurns - a.avgTurns,
      avgDurationMs: f.avgDurationMs - a.avgDurationMs,
    },
  };
}

/** 纯函数：两个 profile 的跑批结果 → 对照报告。 */
export function computeAblation(fullResults: readonly RunResult[], ablationResults: readonly RunResult[]): AblationReport {
  const taskIds = [...new Set([...fullResults, ...ablationResults].map((r) => r.task_id))].sort();
  const rows = taskIds.map((id) =>
    row(
      id,
      fullResults.filter((r) => r.task_id === id),
      ablationResults.filter((r) => r.task_id === id),
    ),
  );
  const overall = row('OVERALL', [...fullResults], [...ablationResults]);
  const arms = [overall.full, overall.ablation, ...rows.flatMap((r) => [r.full, r.ablation])];
  return {
    rows,
    overall,
    anyInsufficient: arms.some((a) => a.ciHalfWidth > CI_HALF_WIDTH_MAX),
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

/** 渲染 Markdown 报告。 */
export function renderAblation(report: AblationReport): string {
  const lines: string[] = [
    '# Ablation — harness 的边际贡献',
    '',
    '> Δ = full − ablation。正数表示 harness 有正贡献。',
    '> 成功率分母已剔除 harness 故障 run（环境坏不是模型失败）；两臂的剔除规则一致。',
    '',
    `**总体**：成功率 ${pct(report.overall.full.successRate)}（full）vs ${pct(report.overall.ablation.successRate)}（ablation）→ **Δ ${pct(report.overall.delta.successRate)}**`,
    '',
    '| 任务 | full 成功率 | ablation 成功率 | Δ 成功率 | Δ 轮次 | Δ 耗时 |',
    '|------|------------|----------------|---------|--------|--------|',
  ];
  for (const r of report.rows) {
    lines.push(
      `| ${r.task_id} | ${pct(r.full.successRate)} (${r.full.successes}/${r.full.scoredRuns}) | ` +
        `${pct(r.ablation.successRate)} (${r.ablation.successes}/${r.ablation.scoredRuns}) | ` +
        `${pct(r.delta.successRate)} | ${r.delta.avgTurns >= 0 ? '+' : ''}${r.delta.avgTurns.toFixed(1)} | ` +
        `${(r.delta.avgDurationMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push(
    '',
    '## 置信区间（Wilson 95%）',
    '',
    '| 臂 | 成功率 | 95% CI | 半宽 |',
    '|----|--------|--------|------|',
    `| full 总体 | ${pct(report.overall.full.successRate)} | [${pct(report.overall.full.ci[0])}, ${pct(report.overall.full.ci[1])}] | ${pct(report.overall.full.ciHalfWidth)} |`,
    `| ablation 总体 | ${pct(report.overall.ablation.successRate)} | [${pct(report.overall.ablation.ci[0])}, ${pct(report.overall.ablation.ci[1])}] | ${pct(report.overall.ablation.ciHalfWidth)} |`,
  );
  lines.push('');
  if (report.anyInsufficient) {
    lines.push(
      `> ⚠️ **有臂的 CI 半宽超过 ${pct(CI_HALF_WIDTH_MAX)}，本报告只能作方向性参考，不得作为定量结论引用。**`,
    );
  } else {
    lines.push('> ✅ 所有臂的 CI 半宽均在阈值内，可作定量表述（仍需说明覆盖的任务与模型范围）。');
  }
  const he = report.overall.full.harnessErrorRuns + report.overall.ablation.harnessErrorRuns;
  if (he > 0) lines.push('', `> 环境故障 run 共 ${he} 例，已从成功率分母剔除并单独计数。`);
  return lines.join('\n');
}
