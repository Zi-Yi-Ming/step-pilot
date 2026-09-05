#!/usr/bin/env tsx
/**
 * validation-loop 后验指标 CLI（只读，不触碰 runner / reporter / 原始结果文件）。
 *
 * 用法：
 *   npx tsx benchmark/analysis/cli.ts benchmark/results/ab-B1.json [...more]
 *   npx tsx benchmark/analysis/cli.ts --json benchmark/results/ab-B1.json
 *
 * 输入是一份或多份 benchmark 结果 JSON（{ results: RunResult[] }）。
 */
import { readFileSync } from 'node:fs';
import { metricsFromReport, type ValidationMetrics } from './validationMetrics.js';

interface Row {
  runLabel: string;
  metrics: ValidationMetrics;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const files = argv.filter((a) => a !== '--json');
  if (files.length === 0) {
    console.error('用法：npx tsx benchmark/analysis/cli.ts [--json] <result.json> [...]\n原始 baseline 文件只读，本脚本不写任何结果文件。');
    process.exit(1);
  }

  const rows: Row[] = [];
  for (const file of files) {
    const report = JSON.parse(readFileSync(file, 'utf8')) as { results: Parameters<typeof metricsFromReport>[0]['results'] };
    for (const m of metricsFromReport(report)) {
      rows.push({ runLabel: `${file.match(/([^/\\]+)\.json$/)?.[1] ?? file} ${m.runLabel}`, metrics: m });
    }
  }

  if (asJson) {
    console.log(JSON.stringify(rows.map((r) => ({ runLabel: r.runLabel, ...r.metrics })), null, 2));
    return;
  }

  console.log('run                turns  valExec  fullSuiteCK          reg  impr  mono   maxGap  finalGap  W/E       rewrite');
  for (const { runLabel, metrics: m } of rows) {
    const cks = m.fullSuiteCheckpoints.map((c) => `T${c.turn}(${c.failed}F@${c.total > 0 ? c.total : '?'}t)`).join(',') || '-';
    const wE = m.rewriteRatio === null ? '-' : `${m.writeCount}/${m.editCount}`;
    const rw = m.rewriteRatio === null ? '-' : m.rewriteRatio.toFixed(2);
    console.log(
      runLabel.padEnd(18) +
        String(m.turns).padStart(6) +
        String(m.validationExecutions).padStart(9) +
        (' ' + cks).padEnd(30) +
        String(m.regressionCount).padStart(4) +
        String(m.improvementCount).padStart(6) +
        m.monotonicity.toFixed(2).padStart(6) +
        String(m.maxValidationGap).padStart(8) +
        String(m.finalValidationGap).padStart(10) +
        (' ' + wE).padStart(10) +
        rw.padStart(9),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
