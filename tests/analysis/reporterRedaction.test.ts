/**
 * benchmark 结果写盘脱敏。
 *
 * 真实事故：一次跑偏的 run 把 `~/.step-pilot/config.toml` 整份打印到模型输出里，
 * 明文 api_key 随之进入 `benchmark/results/*.json`——而这类文件会被提交、会被上传成
 * CI artifact。项目里早有 `redactSecrets` / `redactByKeyName`（日志与 debug-zip 在用），
 * 但 benchmark 这条链路一次都没调用过。
 *
 * 这里守住两件事：结构化敏感字段名要擦；**藏在自由文本里的密钥也要擦**（那次事故正是
 * 密钥出现在模型输出的一段代码块中，字段名并不在关键位）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeReport } from '../../benchmark/reporter.js';
import type { BenchmarkReport } from '../../benchmark/types.js';

/** 形似真实泄露样本的密钥（非 sk- 前缀，StepFun 风格）。 */
const LIVE_KEY = '3nwJClixeGDubgTk18ONplVOUNorqLzzwMnnLRzcJ183AksBberS7Nh8uyfMqt8Kg';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'report-redact-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function reportWith(patch: Record<string, unknown>): BenchmarkReport {
  return {
    benchmark_version: '1',
    timestamp: '2026-09-20T00:00:00.000Z',
    model: 'step-3.7-flash',
    provider: 'stepfun',
    step_pilot_commit: 'abc1234',
    profiles: ['full'],
    results: [],
    summaries: {},
    ...patch,
  } as unknown as BenchmarkReport;
}

describe('writeReport：写盘前必须脱敏', () => {
  it('自由文本里的 api_key = "..." 被擦掉（那次事故的真实形态）', () => {
    const path = join(dir, 'r.json');
    writeReport(
      reportWith({
        results: [
          {
            task_id: 't',
            events: [
              { type: 'text', text: '当前 ~/.step-pilot/config.toml 内容如下：\napi_key = "' + LIVE_KEY + '"' },
            ],
          },
        ],
      }),
      path,
    );
    const written = readFileSync(path, 'utf8');
    expect(written).not.toContain(LIVE_KEY);
    expect(written).toContain('[REDACTED]');
  });

  it('结构化敏感字段名（api_key / token / secret）被擦掉', () => {
    const path = join(dir, 'r.json');
    writeReport(
      reportWith({
        results: [
          {
            task_id: 't',
            events: [{ type: 'usage', api_key: LIVE_KEY, token: LIVE_KEY, secret: LIVE_KEY, turns: 3 }],
          },
        ],
      }),
      path,
    );
    const written = readFileSync(path, 'utf8');
    expect(written).not.toContain(LIVE_KEY);
    // 非敏感字段必须原样保留——脱敏不能把报告变成废纸
    expect(written).toContain('"turns": 3');
  });

  it('普通内容不受影响（不能把报告擦成废纸）', () => {
    const path = join(dir, 'r.json');
    writeReport(
      reportWith({
        results: [{ task_id: 'single-file-bug-001', turns: 6, tool_calls: 7, success: true }],
      }),
      path,
    );
    const written = JSON.parse(readFileSync(path, 'utf8')) as { results: { task_id: string; turns: number }[] };
    expect(written.results[0]!.task_id).toBe('single-file-bug-001');
    expect(written.results[0]!.turns).toBe(6);
  });

  it('嵌套数组与深层对象都能走到（事件流是深层结构）', () => {
    const path = join(dir, 'r.json');
    writeReport(
      reportWith({
        results: [{ events: [{ nested: [{ deep: { text: 'token = ' + LIVE_KEY } }] }] }],
      }),
      path,
    );
    expect(readFileSync(path, 'utf8')).not.toContain(LIVE_KEY);
  });
});
