/**
 * MissionStore：Mission manifest 与事件日志的读写。
 *
 * 布局：`<baseDir>/<workdirKey(repo)>/<missionId>.json` + `<missionId>.events.jsonl`
 * - manifest 是**可重建的派生物**，事件日志才是事实源（同 SessionStore 的「快照是检查点、
 *   事件是事实源」口径）。因此 manifest 用 tmp+rename 原子写，事件用 append-only。
 * - 事件日志只追加、永不重写；读取时容忍损坏行（跳过并计数）。
 * - Mission 不写进会话 wire.jsonl：两者生命周期不同，混写会让会话恢复被任务状态污染。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { workdirKey } from '../../session/store.js';
import { applyMissionEvent, replayMissionEvents } from './state.js';
import {
  MISSION_FORMAT_VERSION,
  MISSION_MANIFEST_VERSION,
  type MissionAcceptance,
  type MissionEvent,
  type MissionManifest,
  type MissionPolicy,
  type MissionScope,
  type MissionStatus,
  type MissionView,
} from './types.js';

/** 创建 Mission 的入参。 */
export interface CreateMissionInput {
  /** 任务所属仓库绝对路径。 */
  repo: string;
  objective: string;
  acceptance: MissionAcceptance[];
  policy?: MissionPolicy;
  /** 任务级范围约束（可选）：verify 时按第一个检查点的 HEAD 检查变更范围。 */
  scope?: MissionScope;
  /** 关联的会话 id（可选）：让 resume 能找回悬空 tool_use。 */
  sessionId?: string;
  /** 测试可注入固定 missionId。 */
  missionId?: string;
  /** 测试可注入固定时间戳。 */
  now?: () => Date;
}

/** 事件日志的一行解析失败时的统计（供 status 暴露「有东西不对」）。 */
export interface MissionLogHealth {
  /** 无法解析的损坏行数量。 */
  corruptLines: number;
}

/** 事件日志尾部追加的入参：seq / ts / eventId 由 store 补齐。 */
export type MissionEventInput =
  | { type: 'mission.status_changed'; from: MissionStatus; to: MissionStatus; reason?: string }
  | {
      type: 'checkpoint.created';
      checkpointId: string;
      label: string;
      gitHead?: string;
      changedFiles?: string[];
      dirty?: boolean;
    }
  | { type: 'recovery.started'; fromCheckpointId?: string; reason: string }
  | { type: 'recovery.completed'; replayedEvents: number }
  | { type: 'verification.completed'; verifierId: string; passed: boolean; harnessError?: boolean; evidenceRef?: string };

/**
 * `mission.created` 只由 create() 写，不出现在公开的 appendEvent 入参里——
 * 否则调用方可以凭空再插一条「创建」事件，把事实链读成两次创建。
 */
type CreatedEventInput = { type: 'mission.created'; repo: string; objective: string; acceptanceCount: number };

/**
 * 由现有事件构造下一条事件（补齐 seq / ts / eventId / missionId）。
 *
 * seq 取「现有最大 seq + 1」，不是「行数 + 1」——后者在日志有缺口时会复用已用过的序号，
 * 让缺口检测失效。ts / eventId 由这里补齐，调用方不自己造。
 */
function buildEvent(
  existing: readonly MissionEvent[],
  missionId: string,
  input: MissionEventInput | CreatedEventInput,
): MissionEvent {
  let maxSeq = 0;
  for (const e of existing) {
    if (e.seq > maxSeq) maxSeq = e.seq;
  }
  return {
    eventId: newEventId(),
    seq: maxSeq + 1,
    ts: new Date().toISOString(),
    missionId,
    attemptId: 'attempt-1',
    ...input,
  } as MissionEvent;
}

export class MissionStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.step-pilot', 'missions');
  }

  /** 该仓库的 Mission 桶目录。 */
  dirFor(repo: string): string {
    return join(this.baseDir, workdirKey(repo));
  }

  manifestPath(repo: string, missionId: string): string {
    return join(this.dirFor(repo), `${missionId}.json`);
  }

  eventsPath(repo: string, missionId: string): string {
    return join(this.dirFor(repo), `${missionId}.events.jsonl`);
  }

  /** 证据包目录：`<mission 桶>/<missionId>.evidence/`，与事件日志同桶，绝不写进会话 wire。 */
  evidenceDir(repo: string, missionId: string): string {
    return join(this.dirFor(repo), `${missionId}.evidence`);
  }

  /**
   * 写一份验证证据文件，返回文件名（供 `verification.completed.evidenceRef` 引用）。
   *
   * 证据与事件日志分离：事件日志只放事实（含引用），完整 stdout/stderr 进证据文件，
   * 避免一次失败的长输出把 append-only 日志撑爆、也让 `replay` 保持轻量。
   */
  writeEvidenceFile(repo: string, missionId: string, content: string): string {
    const dir = this.evidenceDir(repo, missionId);
    mkdirSync(dir, { recursive: true });
    const name = `evidence-${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 12)}.json`;
    writeFileSync(join(dir, name), content, 'utf8');
    return name;
  }

  /**
   * 创建 Mission：写 manifest + 首条 `mission.created` 事件。
   *
   * 返回 manifest。missionId 冲突时直接抛错而不是覆盖——覆盖会静默销毁既有事实链。
   */
  create(input: CreateMissionInput): MissionManifest {
    const now = input.now?.() ?? new Date();
    const ts = now.toISOString();
    const missionId = input.missionId ?? newMissionId(now);
    const dir = this.dirFor(input.repo);
    mkdirSync(dir, { recursive: true });
    const manifestPath = this.manifestPath(input.repo, missionId);
    if (existsSync(manifestPath)) {
      throw new Error(`Mission 已存在：${missionId}（拒绝覆盖既有事实链）`);
    }
    const manifest: MissionManifest = {
      manifestVersion: MISSION_MANIFEST_VERSION,
      missionId,
      repo: input.repo,
      objective: input.objective,
      acceptance: input.acceptance,
      policy: input.policy ?? {},
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      createdAt: ts,
      ...(input.sessionId !== undefined && input.sessionId !== '' ? { sessionId: input.sessionId } : {}),
    };
    writeAtomic(manifestPath, JSON.stringify(manifest, null, 2));
    // 首条事件：走同一套追加路径（此时日志必然为空 → seq=1；mission.created 不改变状态，恒合法）
    this.appendValidated(input.repo, missionId, {
      type: 'mission.created',
      repo: input.repo,
      objective: input.objective,
      acceptanceCount: input.acceptance.length,
    });
    return manifest;
  }

  /**
   * 追加一条事件，**写入前先用状态机校验**。
   *
   * 为什么校验必须在写入侧：读取侧（replayMissionEvents）是容错的——它跳过非法迁移并计数。
   * 如果写入侧不校验，非法事件会被真真切切写进事实源，然后每次读取都「跳过并告警」，
   * 事实源里于是长期躺着一堆永远不被采信、却永远存在的垃圾。校验前移后，
   * 盘上只可能出现合法事件，读取侧的容错只用来兜「外部改写 / 手工编辑」这一种情况。
   *
   * 代价：每次追加都要读一遍日志并重放（P0 阶段日志很小，可接受；
   * 日志增长后再引入内存态缓存，但**不要**为了省这次读而放弃写入侧校验）。
   *
   * @throws MissionTransitionError 非法迁移；@throws Error Mission 不存在
   */
  appendEvent(repo: string, missionId: string, input: MissionEventInput): MissionEvent {
    return this.appendValidated(repo, missionId, input);
  }

  /** 统一追加路径：公开入参与 created 事件共用同一套 seq 逻辑与写入前校验。 */
  private appendValidated(
    repo: string,
    missionId: string,
    input: MissionEventInput | CreatedEventInput,
  ): MissionEvent {
    const view = this.load(repo, missionId);
    if (view === null) {
      throw new Error(`Mission 不存在：${missionId}`);
    }
    const event = buildEvent(view.events, missionId, input);
    // 在副本上校验：非法迁移在落盘前抛出，事实源保持干净
    applyMissionEvent({ ...view.state }, event);
    appendFileSync(this.eventsPath(repo, missionId), `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  /** 读取事件日志（容忍损坏行，返回健康统计）。 */
  readEvents(repo: string, missionId: string): { events: MissionEvent[]; health: MissionLogHealth } {
    const file = this.eventsPath(repo, missionId);
    if (!existsSync(file)) return { events: [], health: { corruptLines: 0 } };
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return { events: [], health: { corruptLines: 0 } };
    }
    const events: MissionEvent[] = [];
    let corruptLines = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      const parsed = parseEventLine(line);
      if (parsed === null) {
        corruptLines += 1;
        continue;
      }
      events.push(parsed);
    }
    return { events, health: { corruptLines } };
  }

  /** 载入 manifest（不读事件）。 */
  loadManifest(repo: string, missionId: string): MissionManifest | null {
    const file = this.manifestPath(repo, missionId);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as MissionManifest;
      if (typeof parsed.missionId !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * 载入完整视图：manifest + 事件重放后的派生状态。
   * manifest 缺失返回 null；事件日志缺失时返回空事件的 planned 态（不伪造进度）。
   */
  load(repo: string, missionId: string): (MissionView & { health: MissionLogHealth }) | null {
    const manifest = this.loadManifest(repo, missionId);
    if (manifest === null) return null;
    const { events, health } = this.readEvents(repo, missionId);
    const state = replayMissionEvents(events);
    return { manifest, state, events, health };
  }

  /** 列出该仓库下的全部 Mission（按 createdAt 倒序）。manifest 损坏的条目跳过。 */
  list(repo: string): MissionManifest[] {
    const dir = this.dirFor(repo);
    if (!existsSync(dir)) return [];
    const out: MissionManifest[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) as MissionManifest;
        if (typeof parsed.missionId === 'string') out.push(parsed);
      } catch {
        // 跳过损坏 manifest：列表要能用，不因单条坏文件整体失败
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  /** 事件日志格式版本（首条 created 事件不带版本，这里从常量读，供 CLI 展示）。 */
  formatVersion(): number {
    return MISSION_FORMAT_VERSION;
  }
}

/** 解析一行事件 JSON；损坏行返回 null（调用方计数跳过）。 */
export function parseEventLine(line: string): MissionEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const event = raw as MissionEvent;
  if (typeof event.type !== 'string') return null;
  if (typeof event.seq !== 'number' || !Number.isFinite(event.seq)) return null;
  return event;
}

/** 生成 missionId：时间前缀 + 随机，便于人读且不冲突。 */
export function newMissionId(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 6);
  return `mission-${ts}-${rand}`;
}

/** 生成 eventId。 */
function newEventId(): string {
  const rand = createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 12);
  return `evt-${rand}`;
}

/** tmp + rename 原子写：先写临时文件再替换目标，避免半写 manifest 被当成完整数据。 */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}
