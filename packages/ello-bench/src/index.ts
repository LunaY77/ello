/**
 * `@ello/bench` 的公共类型、固定任务声明、执行端口和计划生成入口。
 *
 * 执行器按 job 生命周期写入 raw evidence，再由独立 verifier 生成结果。
 */
export * from './domain/contract/index.js';
export { sha256, stableJson } from './domain/hash.js';
export { createPlan, expandJobs } from './domain/suite/plan.js';
export type * from './ports/agent.js';
export type * from './ports/artifact-store.js';
export type * from './ports/attempt.js';
export type * from './ports/clock.js';
export type * from './ports/container.js';
export type * from './ports/corpus.js';
export type * from './ports/matrix.js';
export type * from './ports/verifier.js';
export {
  DEEP_SWE_SOURCE_REPOSITORY,
  DEEP_SWE_SOURCE_REVISION,
  DEEP_SWE_TASK_SET_HASH,
  DEEP_SWE_TASKS,
} from './domain/suite/deep-swe.js';
export {
  SWE_BENCH_PRO_SOURCE_REPOSITORY,
  SWE_BENCH_PRO_SOURCE_REVISION,
  SWE_BENCH_PRO_TASK_SET_HASH,
  SWE_BENCH_PRO_TASKS,
} from './domain/suite/swe-bench-pro.js';
