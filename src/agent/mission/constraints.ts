/**
 * Mission 约束钉扎：把会话关联的活跃 Mission 的目标 / 验收 / 范围写进 system 层。
 *
 * 为什么放 system 而不是压缩后重注入：system 整块不参与压缩（compaction 只重写
 * messages），约束放进 system 就天然跨压缩存活——「约束如何被持续钉住」的结构解，
 * 而不是靠每次压缩后再补一发注入（那是把问题搬进压缩路径的时序里）。
 *
 * 查找语义：按会话 id 匹配 manifest.sessionId，**非终态**优先取最近创建的。
 * 终态（completed/stopped）Mission 不注入——已验收通过或已停止的约束不再约束执行。
 */
import { isTerminal } from './state.js';
import type { MissionStore } from './store.js';
import type { MissionManifest, MissionStatus } from './types.js';

/** 会话关联的活跃 Mission（manifest + 当前状态快照）。 */
export interface SessionMissionRef {
  manifest: MissionManifest;
  status: MissionStatus;
}

/**
 * 找会话关联的活跃 Mission。store.list 按 createdAt 倒序，首个命中即最近创建。
 * 找不到关联、或关联的全部处于终态时返回 undefined（不注入，也不报错——Mission 是可选关联）。
 */
export function findSessionMission(
  store: MissionStore,
  repo: string,
  sessionId: string,
): SessionMissionRef | undefined {
  for (const manifest of store.list(repo)) {
    if (manifest.sessionId !== sessionId) continue;
    const view = store.load(repo, manifest.missionId);
    if (view === null) continue;
    if (isTerminal(view.state.status)) continue;
    return { manifest, status: view.state.status };
  }
  return undefined;
}

/**
 * 由 manifest 构造 system 注入段（纯函数，模型侧英文，对齐 system prompt 语言）。
 *
 * 诚实性约束：状态是**启动时快照**（system 静态，不随 Mission 推进更新）；
 * 完成判定只归 `step mission verify`，正文里明确写出，防止模型把约束段读成「已完成」。
 */
export function buildMissionConstraintBlock(manifest: MissionManifest, status: MissionStatus): string {
  const lines: string[] = [];
  lines.push('## Associated Mission (pinned constraints)');
  lines.push('');
  lines.push(
    'This session is associated with an active engineering Mission. These constraints are pinned in system (they survive context compaction) and stay in force for the whole session.',
  );
  lines.push('');
  lines.push(`- Objective: ${manifest.objective}`);
  if (manifest.acceptance.length > 0) {
    lines.push('- Acceptance (independently verified; do NOT declare completion yourself):');
    for (const a of manifest.acceptance) {
      lines.push(`  - \`${a.command}\` (expect exit ${a.expectExit})${a.description !== undefined ? ` — ${a.description}` : ''}`);
    }
  } else {
    lines.push('- Acceptance: none recorded yet (without machine-checkable criteria the Mission must not be judged complete).');
  }
  if (manifest.scope !== undefined && manifest.scope.allowFiles.length > 0) {
    lines.push('- Scope (enforced at verification; changing files outside these globs fails acceptance):');
    for (const p of manifest.scope.allowFiles) {
      lines.push(`  - ${p}`);
    }
  }
  lines.push(
    `- Mission status snapshot: ${status} (captured at session start). Completion is decided only by \`step mission verify ${manifest.missionId}\`.`,
  );
  return lines.join('\n');
}
