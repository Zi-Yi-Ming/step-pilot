import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkReport, BenchmarkSummary, RunResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

    const failureRuns = runs.filter((r) => !r.success);
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
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
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
