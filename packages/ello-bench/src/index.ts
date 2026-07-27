/**
 * `@ello/bench` 的公共类型、固定任务声明、执行端口和计划生成入口。
 *
 * 执行器按 job 生命周期写入 raw evidence，再由独立 verifier 生成结果。
 */
export * from './contracts.js';
export {
  DEFAULT_CONFIG_PATH,
  loadBenchmarkConfig,
  resolveBenchmarkDefinition,
} from './config.js';
export { createDockerShell } from './docker-shell.js';
export type {
  DockerExecutor,
  DockerShellEvent,
  DockerShellOptions,
} from './docker-shell.js';
export { createEventCaptureRecorder } from './event-capture.js';
export type { EventCaptureRecorder } from './event-capture.js';
export { sha256, stableJson } from './hash.js';
export { createPlan, expandJobs } from './matrix.js';
export { runBenchmarkMatrix } from './matrix-runner.js';
export type { MatrixRunResult } from './matrix-runner.js';
export { generateSuiteReport } from './report.js';
export { createBenchmarkAgentRuntime } from './runtime.js';
export type { BenchmarkAgentRuntimeOptions } from './runtime.js';
export { startBenchmarkServer } from './server.js';
export type { BenchmarkServer, BenchmarkServerOptions } from './server.js';
export {
  ensureTaskCorpus,
  loadResolvedTask,
  validateCorpusTasks,
} from './task-corpus.js';
export type { ResolvedTaskFiles } from './task-corpus.js';
export {
  getBenchmarkSuite,
  getBenchmarkSuiteById,
  getBenchmarkSuiteForTask,
} from './suite.js';
export { validateRunRoot } from './validation.js';
export {
  DEEP_SWE_SOURCE_REPOSITORY,
  DEEP_SWE_SOURCE_REVISION,
  DEEP_SWE_TASK_SET_HASH,
  DEEP_SWE_TASKS,
} from './tasks.js';
export {
  SWE_BENCH_PRO_SOURCE_REPOSITORY,
  SWE_BENCH_PRO_SOURCE_REVISION,
  SWE_BENCH_PRO_TASK_SET_HASH,
  SWE_BENCH_PRO_TASKS,
} from './swe-bench-pro-tasks.js';
