#!/usr/bin/env tsx
/**
 * wall-clock decomposition CLI（步骤③，只读）。
 *
 * 用法：
 *   npx tsx benchmark/analysis/decomposeCli.ts benchmark/results/xxx.json [...]
 *   npx tsx benchmark/analysis/decomposeCli.ts --json benchmark/results/xxx.json
 *
 * 输入 benchmark 结果 JSON（{ results: RunResult[] }）。v3 baseline（无 mono 字段）
 * 会输出 no-timing-data 状态 + 外部 duration_ms（含 setup/teardown，非 agent 纯耗时）。
 */
import { readFileSync } from 'node:fs';
import { decomposeWallClock, type WallClockDecomposition } from './wallClock.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const files = argv.filter((a) => a !== '--json');
  if (files.length === 0) {
    console.error('用法：npx tsx benchmark/analysis/decomposeCli.ts [--json] <result.json> [...]\n原始结果文件只读，本脚本不写任何文件。');
    process.exit(1);
  }

  const rows: Array<{ label: string; durationMsExternal: number; d: WallClockDecomposition }> = [];
  for (const file of files) {
    const report = JSON.parse(readFileSync(file, 'utf8')) as { results: Array<{ events: never[]; duration_ms: number; run_index: number; profile: string }> };
    for (const r of report.results) {
      const label = `${file.match(/([^/\\]+)\.json$/)?.[1] ?? file} #${r.run_index}(${r.profile})`;
      rows.push({ label, durationMsExternal: r.duration_ms, d: decomposeWallClock(r.events) });
    }
  }

  if (asJson) {
    console.log(JSON.stringify(rows.map(({ label, durationMsExternal, d }) => ({ label, durationMsExternal, decomposition: d })), null, 2));
    return;
  }

  const pct = (ms: number, total: number | null): string =>
    total !== null && total > 0 ? `${ms.toFixed(0)}ms(${((ms / total) * 100).toFixed(1)}%)` : `${ms.toFixed(0)}ms`;
  for (const { label, durationMsExternal, d } of rows) {
    console.log('=== ' + label);
    if (d.status === 'no-timing-data') {
      console.log(`  状态: no-timing-data（事件流无 mono 字段，逐事件归因不可行）`);
      console.log(`  外部 duration_ms = ${durationMsExternal}（含 setup.sh + teardown，非 agent 纯耗时，仅供参考）`);
      for (const a of d.anomalies) console.log('  anomaly: ' + a);
      continue;
    }
    const total = d.totalElapsedMs;
    console.log(`  total(agent, mono) = ${total?.toFixed(0)}ms | 外部 duration_ms = ${durationMsExternal}（含 setup/teardown）`);
    console.log(`  model = ${pct(d.modelMs, total)} | tool = ${pct(d.toolMs, total)} | test = ${pct(d.testMs, total)} | wait = ${pct(d.waitMs, total)} | other = ${pct(d.otherMs, total)} | coverage = ${d.coveragePct?.toFixed(1) ?? '?'}%`);
    console.log(`  modelWindows=${d.modelWindows.length} toolWindows=${d.toolWindows.length}(test=${d.toolWindows.filter((w) => w.category === 'test').length}) anomalies=${d.anomalies.length}${d.monotonicityViolated ? ' ⚠ MONO 非单调' : ''}`);
    for (const a of d.anomalies.slice(0, 5)) console.log('  anomaly: ' + a);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
