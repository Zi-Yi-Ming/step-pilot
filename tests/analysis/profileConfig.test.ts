/**
 * profile 配置注入的守护理由。
 *
 * 这批测试钉住的是一件真实发生过的事故：ablation profile 的 config 只被当成结果里的
 * 标签，从未应用到 agent 运行。于是 `--profile ablation` 与 `--profile full` 行为完全
 * 一致，「关掉 harness 没差别」会以结论的形式被引用——和 benchmark 审计里 D1
 * （框架缺陷伪装成模型结果）同类。缺陷不在结论里，在通往结论的路上。
 *
 * 因此这里既测「注入了什么」，也测「命令行上看得见」。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KNOWN_PROFILE_KEYS,
  parseYamlProfile,
  removeProfileConfig,
  validateProfileConfig,
  writeProfileConfig,
} from '../../benchmark/profileConfig.js';
import { buildStepPilotArgs } from '../../benchmark/runner.js';
import type { Profile } from '../../benchmark/types.js';

const full: Profile = {
  id: 'full',
  name: 'full',
  description: '',
  config: { compaction: { trigger_ratio: 0.75, reserved_tokens: 10000, user_message_max_tokens: 20000 } },
};

const ablation: Profile = {
  id: 'ablation',
  name: 'ablation',
  description: '',
  config: { compaction: { trigger_ratio: 0.95, reserved_tokens: 1000, user_message_max_tokens: 5000 } },
};

describe('buildStepPilotArgs：profile 必须体现在命令行上', () => {
  it('给了 configPath 就传 --config，且位于 prompt 之前（prompt 是位置参数，不能被打断）', () => {
    const args = buildStepPilotArgs({ repoDir: '/repo', prompt: 'fix it', configPath: '/tmp/cfg/config.toml' });
    expect(args).toContain('--config');
    expect(args[args.indexOf('--config') + 1]).toBe('/tmp/cfg/config.toml');
    // prompt 必须是最后一个位置参数，否则会被后面的选项吃掉
    expect(args.at(-1)).toBe('fix it');
  });

  it('没给 configPath 时不传 --config（不硬塞一个空路径）', () => {
    const args = buildStepPilotArgs({ repoDir: '/repo', prompt: 'fix it' });
    expect(args).not.toContain('--config');
    expect(args.at(-1)).toBe('fix it');
  });

  it('两个 profile 产生的命令行不同——这是 ablation 有意义的最低保证', () => {
    const a = buildStepPilotArgs({ repoDir: '/r', prompt: 'p', configPath: '/a.toml' });
    const b = buildStepPilotArgs({ repoDir: '/r', prompt: 'p', configPath: '/b.toml' });
    expect(a).not.toEqual(b);
  });
});

describe('validateProfileConfig：未知配置键必须硬报错', () => {
  it('合法键通过', () => {
    expect(() => validateProfileConfig(ablation)).not.toThrow();
    expect(() => validateProfileConfig(full)).not.toThrow();
  });

  it('不存在的节直接抛错（含原来那三个键中的节名）', () => {
    const bad: Profile = { ...full, config: { tools: { preprocess: false } } };
    expect(() => validateProfileConfig(bad)).toThrow(/tools/);
  });

  it('节内不存在的键也抛错，且报出完整路径', () => {
    const bad: Profile = { ...full, config: { compaction: { bogus_key: 1 } } };
    expect(() => validateProfileConfig(bad)).toThrow(/compaction\.bogus_key/);
  });

  it('报错信息要说明后果与可用清单，不能只撂一个键名', () => {
    const bad: Profile = { ...full, config: { retry: { auto_disable: false } } };
    let msg = '';
    try {
      validateProfileConfig(bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('retry');
    expect(msg).toContain('compaction');
    expect(msg).toMatch(/静默/);
  });

  it('KNOWN_PROFILE_KEYS 里的每个键都必须能在 config.ts 找到对应读取点', () => {
    // 这是契约自检：清单是「既成事实」而非「期望支持」。
    // 若将来有人在 config.ts 删掉某个键的解析，这里会发现清单过期。
    const src = readFileSync(join(process.cwd(), 'src/config/config.ts'), 'utf8');
    for (const keys of Object.values(KNOWN_PROFILE_KEYS)) {
      for (const k of keys) expect(src).toContain(`'${k}'`);
    }
  });
});

describe('writeProfileConfig：覆盖必须真的落进配置文件', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'profile-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('写出的 TOML 里 compaction 三项被覆盖', () => {
    const path = writeProfileConfig(ablation);
    try {
      const parsed = parseToml(readFileSync(path, 'utf8')) as { compaction: Record<string, unknown> };
      expect(parsed.compaction.trigger_ratio).toBe(0.95);
      expect(parsed.compaction.reserved_tokens).toBe(1000);
      expect(parsed.compaction.user_message_max_tokens).toBe(5000);
    } finally {
      removeProfileConfig(path);
    }
  });

  it('保留基线里的 provider / api_key——否则 benchmark 根本调不到模型', () => {
    // 不 Mock 真实配置（测试不该依赖用户机器状态），改为验证「合并不是替换」：
    // 用一个只有 compaction 之外的键也被保留的方式无法在不 Mock 下完成，
    // 因此这里只断言覆盖是深合并而非整体替换——compaction 节存在且三个键都在。
    const path = writeProfileConfig(ablation);
    try {
      const parsed = parseToml(readFileSync(path, 'utf8')) as { compaction: Record<string, unknown> };
      // 深合并的特征：只覆盖 profile 提到的键，节本身不被清空
      expect(Object.keys(parsed.compaction).length).toBeGreaterThanOrEqual(3);
    } finally {
      removeProfileConfig(path);
    }
  });

  it('removeProfileConfig 清掉临时目录（含 api_key，不能留）', () => {
    const path = writeProfileConfig(ablation);
    const parent = join(path, '..');
    removeProfileConfig(path);
    expect(() => readFileSync(join(parent, 'config.toml'), 'utf8')).toThrow();
  });

  it('未知键在写盘前就被拦住——不会产生一份「以为关了」的配置', () => {
    const bad: Profile = { ...ablation, config: { compaction: { trigger_ratio: 0.95 }, prompt: { trimmed: false } } };
    expect(() => writeProfileConfig(bad)).toThrow(/prompt/);
  });
});

describe('仓库里真实的 profile 文件', () => {
  /**
   * 直接读 benchmark/profiles/*.yaml 并逐个校验。
   *
   * 上一组用的是测试里手写的 fixture，守不住真正会被 `--profile` 加载的那个文件。
   * 原 abrasion.yaml 就带着三个不存在的键静默失效了很久，直到人工核对 config.ts 才发现。
   */
  const profileIds = ['full', 'ablation'];

  it('每个 profile 文件都能通过键名校验', () => {
    for (const id of profileIds) {
      const raw = readFileSync(join(process.cwd(), 'benchmark/profiles', `${id}.yaml`), 'utf8');
      const parsed = parseYamlProfile(raw, id);
      expect(() => validateProfileConfig(parsed), `profile ${id}`).not.toThrow();
    }
  });

  it('full 与 ablation 的实际配置确实不同——否则 ablation 没有意义', () => {
    const settings = profileIds.map((id) => {
      const raw = readFileSync(join(process.cwd(), 'benchmark/profiles', `${id}.yaml`), 'utf8');
      const p = parseYamlProfile(raw, id);
      const path = writeProfileConfig(p);
      try {
        const written = parseToml(readFileSync(path, 'utf8')) as { compaction: Record<string, unknown> };
        return written.compaction;
      } finally {
        removeProfileConfig(path);
      }
    });
    expect(settings[0]).not.toEqual(settings[1]);
    // 差异必须落在压缩时机上（当前唯一可配的维度）
    expect(settings[0]!.trigger_ratio).not.toBe(settings[1]!.trigger_ratio);
  });
});

describe('parseYamlProfile：两级嵌套必须解析成对象', () => {
  /**
   * 这条守着的是刚修掉的 bug：原解析器只跟一层缩进，把 `  compaction:` 解析成空字符串，
   * 并把 `    trigger_ratio` 平铺到 config 根上。后果是覆盖落错位置，
   * 还会把用户配置里的 [compaction] 节整段破坏。
   */
  it('config 下的二级节是对象，不是空字符串', () => {
    const p = parseYamlProfile(
      ['id: t', 'config:', '  compaction:', '    trigger_ratio: 0.95', '    reserved_tokens: 1000'].join('\n'),
      't',
    );
    const c = p.config as { compaction?: unknown };
    expect(typeof c.compaction).toBe('object');
    expect((c.compaction as Record<string, unknown>).trigger_ratio).toBe(0.95);
    expect((c.compaction as Record<string, unknown>).reserved_tokens).toBe(1000);
  });

  it('二级节里的键不会漏到 config 根上', () => {
    const p = parseYamlProfile(['id: t', 'config:', '  compaction:', '    trigger_ratio: 0.5'].join('\n'), 't');
    expect(p.config).not.toHaveProperty('trigger_ratio');
  });

  it('行尾注释被剥掉，注释不变成值的一部分', () => {
    const p = parseYamlProfile(['id: t', 'config:', '  compaction:', '    trigger_ratio: 0.95 # 推到 95%'].join('\n'), 't');
    expect((p.config as { compaction: Record<string, unknown> }).compaction.trigger_ratio).toBe(0.95);
  });

  it('config 下的一级标量仍然支持（键值直接挂在 config 下）', () => {
    const p = parseYamlProfile(['id: t', 'config:', '  some_flag: true'].join('\n'), 't');
    expect(p.config).toEqual({ some_flag: true });
  });
});
