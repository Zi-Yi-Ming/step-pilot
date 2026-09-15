/**
 * 转出 `src/utils/harnessFailure.ts`。
 *
 * 实现已移到 `src/utils/`，因为 Mission 的 verifier 需要同一套「环境故障 vs 断言失败」
 * 判据，而 `tsconfig` 的 `rootDir` 是 `src`、`src/` 引用不到 `benchmark/` 下的文件。
 * 这里保留同路径转出，既让既有引用方（`runner.ts`、`tests/analysis/harnessFailure.test.ts`）
 * 无需改动，也避免把同一份判据抄成两份（已知的 G7 复制漂移债务）。
 */
export { isHarnessFailure, type CheckOutcome } from '../src/utils/harnessFailure.js';
