#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task, Profile } from './types.js';
import { runTask } from './runner.js';
import { buildReport, renderMarkdown, writeReport } from './reporter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`
benchmark — Small-Model Reliability Benchmark for step-pilot

Usage:
  pnpm benchmark list
  pnpm benchmark run [options]
  pnpm benchmark report [options]

Options:
  --task <id>         Run a specific task
  --profile <name>    Profile to use (default: full)
  --runs <n>          Number of runs per task (default: 3)
  --output <path>     Output file path (default: benchmark/results/<timestamp>.json)
  --compare <a> <b>   Compare two result files
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
        const result = await runTask(task, profile, run);
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
      // If setup is a file path rather than inline script content, read it.
      if (task.setup && typeof task.setup === 'string' && !task.setup.includes('\n')) {
        const setupPath = join(__dirname, '..', task.setup);
        console.error('DEBUG loadTasks task.id=', task.id, 'setupPath=', setupPath, 'exists=', existsSync(setupPath));
        if (existsSync(setupPath)) {
          task.setup = readFileSync(setupPath, 'utf8');
          console.error('DEBUG loadTasks read setup, new length=', task.setup.length);
        } else {
          console.error('DEBUG loadTasks setup file NOT found');
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

      // If setup is a file path rather than inline script content, read it.
      if (task.setup && typeof task.setup === 'string' && !task.setup.includes('\n')) {
        const setupPath = join(__dirname, '..', task.setup);
        if (existsSync(setupPath)) {
          task.setup = readFileSync(setupPath, 'utf8');
        }
      }

  return task as Task;
}

function parseYamlProfile(content: string, id: string): Profile {
  const lines = content.split('\n');
  const profile: any = { id, config: {} };
  let currentSection = '';

  for (const line of lines) {
    if (line.startsWith('config:')) {
      currentSection = 'config';
      continue;
    }
    if (currentSection === 'config' && line.match(/^\s+\w+:/)) {
      const match = line.match(/^\s+(\w+):\s*(.+)/);
      if (match) {
        profile.config[match[1]] = parseValue(match[2]);
      }
    }
    if (!line.startsWith(' ') && line.match(/^\w+:/)) {
      const match = line.match(/^(\w+):\s*(.+)/);
      if (match) {
        profile[match[1]] = parseValue(match[2]);
      }
    }
  }

  return profile as Profile;
}

function parseValue(value: string): any {
  value = value.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
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
