/**
 * profile 配置注入 + 键名校验。
 *
 * ## 为什么需要这个文件
 *
 * ablation profile 的 `config` 此前**只被当作结果里的标签记录，从未应用到 agent 运行**：
 * `runTask` 只收到 profile 名字，spawn 出来的命令是固定的
 * `['-p','--output-format','stream-json','--yolo','-C',repo,prompt]`，没有任何配置覆盖。
 *
 * 后果是跑 `--profile ablation` 会得到与 `--profile full` **完全一样的行为**，于是得出
 * 「ablation 没差别」的**错误结论**——和 benchmark 审计里 D1（框架缺陷伪装成模型结果）
 * 属于同一类事故：缺陷不在结论里，在通往结论的路上。
 *
 * 与之相伴的第二个隐患：profile 引用的配置键可能根本不存在。原
 * `profiles/ablation.yaml` 里的 `tools.preprocess`、`retry.auto_disable`、`prompt.trimmed`
 * 三个键在 `src/config/config.ts` 里**没有对应读取**，写进配置也是静默无效。
 *
 * 因此这里设两道防护：
 * 1. {@link writeProfileConfig} 把 profile 覆盖真正合并进一份临时 config.toml，
 *    由 runner 用 `--config` 传给 agent；
 * 2. {@link validateProfileConfig} 在 profile 引用不存在的键时**硬报错**——
 *    宁可跑不起来，也不要静默产出一个「看起来关了其实没关」的对照实验。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { Profile } from './types.js';

/**
 * `src/config/config.ts` **真实读取**、因而可被 profile 覆盖的配置节 → 键名清单。
 *
 * 这不是「希望支持」的清单，而是逐行核对解析代码后的既成事实。往这里加键之前，
 * 必须先确认 config.ts 里真的读了它——否则就是把幻觉写进契约。
 */
export const KNOWN_PROFILE_KEYS: Readonly<Record<string, readonly string[]>> = {
  compaction: ['trigger_ratio', 'reserved_tokens', 'user_message_max_tokens'],
};

/** 纯函数：普通对象递归合并，标量与数组直接覆盖。 */
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    if (isPlainObject(prev) && isPlainObject(v)) {
      out[k] = deepMerge(prev, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 校验 profile 的 config 只引用真实存在的配置键。
 *
 * 未知键直接抛错：静默忽略会让对照实验在「以为关了」的状态下跑完，
 * 而那种数据比没有数据更有害——它会被当成结论引用。
 */
export function validateProfileConfig(profile: Profile): void {
  const cfg = profile.config;
  if (cfg === undefined) return;

  const unknown: string[] = [];
  for (const [section, value] of Object.entries(cfg)) {
    const allowed = KNOWN_PROFILE_KEYS[section];
    if (allowed === undefined || !isPlainObject(value)) {
      unknown.push(section);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) unknown.push(`${section}.${key}`);
    }
  }

  if (unknown.length > 0) {
    const known = Object.entries(KNOWN_PROFILE_KEYS)
      .map(([s, keys]) => `${s}.{${keys.join('|')}}`)
      .join('，');
    throw new Error(
      `profile "${profile.id}" 引用了不存在的配置键：${unknown.join('，')}。\n` +
        `这些键写进 config.toml 也会被静默忽略，对照实验会在「以为关了」的状态下跑完。\n` +
        `当前可用：${known}`,
    );
  }
}

/**
 * 生成一份带 profile 覆盖的临时 config.toml，返回其路径。
 *
 * 基线取用户真实的 `~/.step-pilot/config.toml`（里面有 provider 与 api_key，
 * benchmark 需要它才能真的调模型），再把 profile 的覆盖节合并上去。
 *
 * 调用方负责在运行结束后 {@link removeProfileConfig}——临时文件含 api_key，
 * 不能留在临时目录里过夜。
 */
export function writeProfileConfig(profile: Profile): string {
  validateProfileConfig(profile);

  const basePath = join(homedir(), '.step-pilot', 'config.toml');
  const base = existsSync(basePath)
    ? (parseToml(readFileSync(basePath, 'utf8')) as Record<string, unknown>)
    : {};

  const merged = deepMerge(base, (profile.config ?? {}) as Record<string, unknown>);
  const dir = mkdtempSync(join(tmpdir(), 'bench-profile-'));
  const file = join(dir, 'config.toml');
  writeFileSync(file, stringifyToml(merged), 'utf8');
  return file;
}

/** 删除 {@link writeProfileConfig} 生成的临时配置（含 api_key，必须清理）。 */
export function removeProfileConfig(path: string): void {
  try {
    rmSync(join(path, '..'), { recursive: true, force: true });
  } catch {
    // 清理失败不掩盖 benchmark 结果；文件在系统临时目录，重启即失效。
  }
}

/** 标量值解析（与 benchmark 其余 YAML 解析共用一份，避免两处实现漂移）。 */
export function parseValue(value: string): unknown {
  value = value.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d\.\d+$/.test(value)) return parseFloat(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 解析 profile YAML（只支持本项目用到的子集：顶层标量 + `config:` 下两级节）。
 *
 * 从 `benchmark/cli.ts` 搬来并**修掉一个真 bug**：原实现只跟踪一层缩进，遇到
 * `config:` → `  compaction:` → `    trigger_ratio:` 这种两级结构时，
 * 会把 `compaction` 解析成空字符串、再把 `trigger_ratio` 平铺到 `config` 根上。
 * 于是 profile 的覆盖既没落到正确位置，还会把用户配置里的 `[compaction]` 节整段破坏掉。
 *
 * 搬到这里是为了可测——bug 能存活，正是因为它在不可测的 CLI 文件里。
 */
export function parseYamlProfile(content: string, id: string): Profile {
  const profile: Record<string, unknown> = { id, config: {} };
  const config = profile.config as Record<string, unknown>;
  let section: 'root' | 'config' | 'nested' = 'root';
  let nestedKey = '';

  for (const rawLine of content.split('\n')) {
    // 行尾注释剥掉（本数据的值不含 #，保持简单）
    const line = rawLine.replace(/\s+#.*$/, '');
    if (line.trim() === '') continue;

    const indent = line.length - line.trimStart().length;
    const m = line.trim().match(/^([\w-]+):\s*(.*)$/);
    if (m === null) continue;

    if (indent === 0) {
      if (m[1] === 'config' && m[2] === '') {
        section = 'config';
        continue;
      }
      profile[m[1]] = parseValue(m[2]);
      section = 'root';
      continue;
    }

    if (section === 'config') {
      if (m[2] === '') {
        nestedKey = m[1];
        config[nestedKey] = {};
        section = 'nested';
      } else {
        config[m[1]] = parseValue(m[2]);
      }
      continue;
    }

    // section === 'nested'
    (config[nestedKey] as Record<string, unknown>)[m[1]] = parseValue(m[2]);
  }

  return profile as unknown as Profile;
}
