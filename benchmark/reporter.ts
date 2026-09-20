import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactByKeyName, redactSecrets } from '../src/utils/redact.js';
import type { BenchmarkReport, BenchmarkSummary, RunResult } from './types.js';


/**
 * 写盘前脱敏。
 *
 * 为什么必须有这一步：benchmark 结果 JSON 会**原样落盘、被提交、被上传成 CI artifact**，
 * 而它包含 agent 跑完全程的完整事件流——其中就有模型的自由文本输出。实测踩过：
 * 一次跑偏的 run 把 `~/.step-pilot/config.toml` 整份打印了出来，明文 api_key 随之进入
 * 结果文件。项目里本来就有 `redactSecrets` / `redactByKeyName`（日志与 debug-zip 在用），
 * 但 benchmark 这条链路一次都没调用过——有刀没使。
 *
 * 两道都要过：
 * - `redactByKeyName` 按字段名确定性擦除（api_key / token / secret…）；
 * - 深层走一遍字符串、对每个值套 `redactSecrets`，兜住「密钥出现在自由文本里」这种形态
 *   （上面那次事故正是如此：值藏在模型输出的一段 ```toml 代码块中，字段名并不在关键位）。
 */
function redactReport(report: BenchmarkReport): BenchmarkReport {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactSecrets(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return redactByKeyName(walk(report) as Record<string, unknown>) as BenchmarkReport;
}

export function summarize(results: RunResult[]): Record<string, BenchmarkSummary> {
  const grouped = new Map<string, RunResult[]>();
  for (const r of results) {
    const key = r.task_id;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  const summaries: Record<string, BenchmarkSummary> = {};
  for (const [taskId, runs] of grouped) {
    const successRuns = runs.filter((r) => r.success);
    const durations = runs.map((r) => r.duration_ms).sort((a, b) => a - b);
    const taxonomy: Record<string, number> = {};
    for (const r of runs) {
      const key = classifyFailure(r);
      taxonomy[key] = (taxonomy[key] || 0) + 1;
    }

    const verifierFailureRuns = runs.filter((r) => r.checks_failed > 0);
    const timeoutRuns = runs.filter((r) => r.failure_reason?.includes('timeout'));

    summaries[taskId] = {
      task_id: taskId,
      runs: runs.length,
      success_rate: successRuns.length / runs.length,
      final_verifier_failure_rate: verifierFailureRuns.length / runs.length,
      timeout_rate: timeoutRuns.length / runs.length,
      mean_duration_ms: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      median_duration_ms: durations[Math.floor(durations.length / 2)] ?? 0,
      mean_turns: Math.round((runs.reduce((a, r) => a + r.turns, 0) / runs.length) * 10) / 10,
      mean_tool_calls: Math.round((runs.reduce((a, r) => a + r.tool_calls, 0) / runs.length) * 10) / 10,
      mean_tool_errors: Math.round((runs.reduce((a, r) => a + r.tool_errors, 0) / runs.length) * 10) / 10,
      mean_retries: Math.round((runs.reduce((a, r) => a + r.retries, 0) / runs.length) * 10) / 10,
      mean_compactions: Math.round((runs.reduce((a, r) => a + r.compactions, 0) / runs.length) * 10) / 10,
      mean_total_tokens: Math.round(runs.reduce((a, r) => a + r.total_tokens, 0) / runs.length),
      failure_taxonomy: taxonomy,
    };
  }
  return summaries;
}

export function buildReport(
  results: RunResult[],
  opts: { benchmark_version: string; model: string; provider: string; step_pilot_commit: string; profiles: string[] },
): BenchmarkReport {
  const timestamp = new Date().toISOString();
  const summaries = summarize(results);

  return {
    benchmark_version: opts.benchmark_version,
    timestamp,
    model: opts.model,
    provider: opts.provider,
    step_pilot_commit: opts.step_pilot_commit,
    profiles: opts.profiles,
    results,
    summaries,
  };
}

export function writeReport(report: BenchmarkReport, outputPath: string): void {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(redactReport(report), null, 2) + '\n', 'utf8');
}

export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [
    '# Benchmark Report',
    '',
    `- **Benchmark version**: ${report.benchmark_version}`,
    `- **Timestamp**: ${report.timestamp}`,
    `- **Model**: ${report.model}`,
    `- **Provider**: ${report.provider}`,
    `- **Commit**: ${report.step_pilot_commit}`,
    `- **Profiles**: ${report.profiles.join(', ')}`,
    '',
    '## Summary',
    '',
    '| Task | Profile | Success | Final Verifier Failure | Timeout | Avg Turns | Avg Tools | Avg Errors | Avg Tokens | Avg Duration |',
    '|------|---------|---------|------------------------|---------|-----------|-----------|------------|------------|--------------|',
  ];

  for (const [taskId, summary] of Object.entries(report.summaries)) {
  lines.push(
    `| ${taskId} | ${report.profiles.join(', ')} | ${(summary.success_rate * 100).toFixed(0)}% | ${(summary.final_verifier_failure_rate * 100).toFixed(0)}% | ${(summary.timeout_rate * 100).toFixed(0)}% | ${summary.mean_turns} | ${summary.mean_tool_calls} | ${summary.mean_tool_errors} | ${summary.mean_total_tokens} | ${summary.mean_duration_ms} |`,
  );
  }

  lines.push('', '## Raw Results', '');
  for (const r of report.results) {
    lines.push(`### ${r.task_id} #${r.run_index}`, '');
    lines.push(`- **Success**: ${r.success ? 'yes' : 'no'}`, `- **Duration**: ${r.duration_ms}ms`, `- **Turns**: ${r.turns}`, `- **Tool calls**: ${r.tool_calls}`, `- **Tool errors**: ${r.tool_errors}`, `- **Retries**: ${r.retries}`, `- **Compactions**: ${r.compactions}`, `- **Total tokens**: ${r.total_tokens}`, `- **Stop reason**: ${r.stop_reason ?? '-'}`, `- **Failure reason**: ${r.failure_reason ?? '-'}`, '');
  }

  return lines.join('\n');
}

function classifyFailure(r: RunResult): string {
  if (r.success) return 'none';
  if (r.failure_reason?.includes('timeout')) return 'timeout';
  if (r.tool_errors > 0 && r.retries > 0) return 'tool_call';
  if (r.compactions > 0 && r.total_tokens > 200_000) return 'compaction';
  if (r.failure_reason?.includes('context') || r.failure_reason?.includes('overflow')) return 'context';
  if (r.retries > 2) return 'loop';
  if (r.failure_reason?.includes('test')) return 'test_failure';
  if (r.failure_reason) return 'other';
  return 'unknown';
}

function existsSync(path: string): boolean {
  try {
    return require('node:fs').existsSync(path);
  } catch {
    return false;
  }
}
