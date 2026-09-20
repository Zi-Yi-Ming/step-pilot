#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task, Profile } from './types.js';
import { runTask } from './runner.js';
import { buildReport, renderMarkdown, writeReport } from './reporter.js';
import { buildDashboard, badgeUrl, loadRunFiles, renderDashboardMd } from './dashboard.js';
import { renderRcr, runFaultBenchmark } from './faultInjection.js';
import { parseValue, parseYamlProfile } from './profileConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`
benchmark — Small-Model Reliability Benchmark for step-pilot

Usage:
  pnpm benchmark list
  pnpm benchmark run [options]
  pnpm benchmark report [options]
  pnpm benchmark dashboard [--dir <results-dir>] [--out <json>] [--badge]
  pnpm benchmark rcr        Fault-injection benchmark + Recovery-Complete Rate (P0-D)

Options:
  --task <id>         Run a specific task
  --profile <name>    Profile to use (default: full)
  --runs <n>          Number of runs per task (default: 3)
  --output <path>     Output file path (default: benchmark/results/<timestamp>.json)
  --compare <a> <b>   Compare two result files

Dashboard options:
  --dir <path>        Results directory to scan (default: benchmark/results)
  --out <path>        Write aggregated dashboard JSON to this path
  --badge             Print a shields.io badge URL for the success rate
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'list':
      await listTasks();
      break;
    case 'run':
      await runBenchmark(args);
      break;
    case 'report':
      await generateReport(args);
      break;
    case 'dashboard':
      await generateDashboard(args);
      break;
    case 'rcr':
      await runRcr();
      break;
    case '--help':
    case 'help':
      usage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

/**
 * P0-D：跑 fault-injection benchmark，输出 RCR。
 *
 * 每个场景在隔离的临时目录里跑真实 Mission 生命周期（create → start → checkpoint →
 * 注入故障 → resume → verify），只注入 verifier 执行器与会话存储，因此不烧 token、
 * 不碰真实 ~/.step-pilot，秒级完成。
 */
async function runRcr(): Promise<void> {
  const { results, report } = await runFaultBenchmark();
  console.log(renderRcr(report));
  console.log('\n## 逐场景明细\n');
  for (const r of results) {
    console.log(
      `- ${r.scenario}: status=${r.finalStatus} verification=${r.verification} ` +
        `hadCheckpoint=${r.hadCheckpoint} danglingClosed=${r.danglingClosed} recovered=${r.recovered}`,
    );
  }
}

async function listTasks() {
  const tasksDir = join(__dirname, 'tasks');
  if (!existsSync(tasksDir)) {
    console.error('Tasks directory not found');
    process.exit(1);
  }

  const categories = readdirSync(tasksDir);
  for (const category of categories) {
    const categoryDir = join(tasksDir, category);
    if (!existsSync(categoryDir)) continue;

    console.log(`\n## ${category}`);
    const tasks = readdirSync(categoryDir);
    for (const taskId of tasks) {
      const taskFile = join(categoryDir, taskId, 'task.yaml');
      if (!existsSync(taskFile)) continue;

      const content = readFileSync(taskFile, 'utf8');
      const task = parseYamlTask(content, `${category}/${taskId}`);
      console.log(`  - ${task.id}: ${task.description} (${task.difficulty})`);
    }
  }
}

async function runBenchmark(args: string[]) {
  const taskIndex = args.indexOf('--task');
  const profileIndex = args.indexOf('--profile');
  const runsIndex = args.indexOf('--runs');
  const outputIndex = args.indexOf('--output');

  const taskId = taskIndex >= 0 ? args[taskIndex + 1] : undefined;
  const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'full';
  const runs = runsIndex >= 0 ? parseInt(args[runsIndex + 1] ?? '3', 10) : 3;
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;

  const tasks = loadTasks(taskId);
  const profileData = loadProfile(profile);

  console.log(`Running benchmark: ${tasks.length} tasks, ${runs} runs each, profile=${profile}`);

  const results = [];
  for (const task of tasks) {
    for (let run = 1; run <= runs; run++) {
      console.log(`  [${task.id}] run ${run}/${runs}...`);
      try {
        const result = await runTask(task, profileData, run);
        results.push(result);
        console.log(`    ${result.success ? '✓' : '✗'} ${result.duration_ms}ms, ${result.turns} turns, ${result.tool_calls} tools`);
      } catch (err) {
        console.error(`    ✗ Error: ${err}`);
        results.push({
          task_id: task.id,
          category: task.category,
          profile,
          model: 'step-3.7-flash',
          provider: 'stepfun',
          step_pilot_commit: getGitCommit(),
          run_index: run,
          success: false,
          duration_ms: 0,
          turns: 0,
          tool_calls: 0,
          tool_errors: 0,
          retries: 0,
          compactions: 0,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          stop_reason: null,
          failure_reason: err instanceof Error ? err.message : String(err),
          checks_passed: 0,
          checks_failed: 0,
          events: [],
        });
      }
    }
  }

  const report = buildReport(results, {
    benchmark_version: '0.1.0',
    model: 'step-3.7-flash',
    provider: 'stepfun',
    step_pilot_commit: getGitCommit(),
    profiles: [profile],
  });

  const outputPath = output ?? join(__dirname, 'results', `${new Date().toISOString().replace(/:/g, '-')}.json`);
  writeReport(report, outputPath);
  console.log(`\nReport written to: ${outputPath}`);
  console.log(renderMarkdown(report));
}

async function generateReport(args: string[]) {
  const inputIndex = args.indexOf('--input');
  const input = inputIndex >= 0 ? args[inputIndex + 1] : undefined;

  if (!input) {
    console.error('Please specify --input <path>');
    process.exit(1);
  }

  const content = readFileSync(input, 'utf8');
  const report = JSON.parse(content) as ReturnType<typeof buildReport>;
  console.log(renderMarkdown(report));
}

/**
 * dashboard —— 跨多次运行聚合出可靠性仪表盘。
 *
 * 与 `report` 的分工：`report` 渲染**单个**结果文件；`dashboard` 扫描**整个结果目录**
 * （或指定的多个文件）聚合，回答「这一阶段的可靠性是什么水平、哪个任务在退化」。
 */
async function generateDashboard(args: string[]) {
  const dirIndex = args.indexOf('--dir');
  const outIndex = args.indexOf('--out');
  const badgeIndex = args.indexOf('--badge');

  const dir = dirIndex >= 0 ? resolve(args[dirIndex + 1]!) : join(__dirname, 'results');
  const reports = loadRunFiles(dir);

  if (reports.length === 0) {
    console.error(`No benchmark result files found in: ${dir}`);
    process.exit(1);
  }

  const dashboard = buildDashboard(reports);
  const md = renderDashboardMd(dashboard);
  console.log(md);

  if (outIndex >= 0) {
    const outPath = resolve(args[outIndex + 1]!);
    const outDir = dirname(outPath);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
    console.log(`Dashboard JSON written to: ${outPath}`);
  }

  if (badgeIndex >= 0) {
    console.log(`Badge: ${badgeUrl(dashboard)}`);
  }
}

function loadTasks(taskId?: string): Task[] {
  const tasksDir = join(__dirname, 'tasks');
  const tasks: Task[] = [];

  const categories = existsSync(tasksDir) ? readdirSync(tasksDir) : [];
  for (const category of categories) {
    const categoryDir = join(tasksDir, category);
    if (!existsSync(categoryDir)) continue;

    const taskDirs = readdirSync(categoryDir);
    for (const taskDir of taskDirs) {
      const taskFile = join(categoryDir, taskDir, 'task.yaml');
      if (!existsSync(taskFile)) continue;

      const content = readFileSync(taskFile, 'utf8');
      const task = parseYamlTask(content, `${category}/${taskDir}`);
      // setup 若写的是文件路径（而非内联脚本），在此读入。
      if (task.setup && typeof task.setup === 'string' && !task.setup.includes('\n')) {
        const setupPath = join(__dirname, '..', task.setup);
        if (existsSync(setupPath)) {
          task.setup = readFileSync(setupPath, 'utf8');
        }
      }
      if (taskId === undefined || task.id === taskId) {
        tasks.push(task);
      }
    }
  }

  return tasks;
}

function loadProfile(profileId: string): Profile {
  const profilePath = join(__dirname, 'profiles', `${profileId}.yaml`);
  if (!existsSync(profilePath)) {
    console.error(`Profile not found: ${profileId}`);
    process.exit(1);
  }

  const content = readFileSync(profilePath, 'utf8');
  return parseYamlProfile(content, profileId);
}

function parseYamlTask(content: string, id: string): Task {
  const lines = content.split('\n');
  const task: any = { id, setup: '', verify: [], timeout: 120 };

  let currentKey = '';
  let inSetup = false;
  let inVerify = false;
  let currentCheck: any = null;
  let currentExpect: any = null;

  for (const line of lines) {
    if (line.startsWith('setup: |') || line.startsWith('setup: >')) {
      inSetup = true;
      inVerify = false;
      continue;
    }
    if (line.startsWith('verify:')) {
      inSetup = false;
      inVerify = true;
      continue;
    }
    if (inSetup) {
      task.setup += line + '\n';
      continue;
    }
    if (inVerify) {
      if (line.match(/^\s*- type:/)) {
        if (currentCheck) task.verify.push(currentCheck);
        currentCheck = { type: line.match(/type:\s*(\w+)/)?.[1] ?? 'command', expect: {} };
      } else if (line.match(/^\s+command:/)) {
        currentCheck.command = line.match(/command:\s*"(.+)"/)?.[1] ?? line.match(/command:\s*(.+)/)?.[1] ?? '';
      } else if (line.match(/^\s+path:/)) {
        currentCheck.path = line.match(/path:\s*"(.+)"/)?.[1] ?? line.match(/path:\s*(.+)/)?.[1] ?? '';
      } else if (line.match(/^\s+pattern:/)) {
        currentCheck.pattern = line.match(/pattern:\s*"(.+)"/)?.[1] ?? line.match(/pattern:\s*(.+)/)?.[1] ?? '';
      } else if (line.match(/^\s+exit_code:/)) {
        currentCheck.expect = currentCheck.expect ?? {};
        currentCheck.expect.exit_code = parseInt(line.match(/exit_code:\s*(\d+)/)?.[1] ?? '0', 10);
      } else if (line.match(/^\s+stdout_contains:/)) {
        currentCheck.expect = currentCheck.expect ?? {};
        currentCheck.expect.stdout_contains = line.match(/stdout_contains:\s*"(.+)"/)?.[1] ?? line.match(/stdout_contains:\s*(.+)/)?.[1] ?? '';
      } else if (line.match(/^\s+stderr_not_contains:/)) {
        currentCheck.expect = currentCheck.expect ?? {};
        currentCheck.expect.stderr_not_contains = line.match(/stderr_not_contains:\s*"(.+)"/)?.[1] ?? line.match(/stderr_not_contains:\s*(.+)/)?.[1] ?? '';
      }
      continue;
    }

    const match = line.match(/^(\w+):\s*(.+)/);
    if (match) {
      const [, key, value] = match;
      task[key] = parseValue(value);
      currentKey = key;
    }
  }

  if (currentCheck) task.verify.push(currentCheck);

  return task as Task;
}

function getGitCommit(): string {
  try {
    const { execSync } = require('node:child_process');
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
