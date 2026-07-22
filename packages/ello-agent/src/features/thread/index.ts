/**
 * Thread feature 的唯一跨 feature 入口。
 *
 * 公开面只包含 factory、feature 类型、订阅边界和持久化 store factory；Thread 的 use case、状态、
 * record 投影与路由实现均留在 feature 内部文件。
 */
import { createThreads, type CreateThreadsInput } from './threads.js';

/**
 * 创建 Thread feature。
 *
 * Args:
 * - `input`: ThreadStore、Agent 启动能力、卸载时间和 settings resolver。
 *
 * Returns:
 * - 返回拥有所有已加载 Thread 状态并负责统一关闭的 feature。
 */
export function createThreadFeature(input: CreateThreadsInput): ThreadFeature {
  return createThreads(input);
}

export { createThreadStore } from './store.js';
export type { ThreadStore } from './store.js';
export {
  createProductionThreadCompactor,
  createThreadCompactor,
} from './compact.js';
export { createThreadTitleGenerator } from './title.js';
export { createThreadGoalRuntime } from './goals/runtime-tools.js';
export { writePlanArtifact } from './plan.js';
export { createExportRoutes } from './export.js';
export { createThreadRoutes } from './routes.js';
export type {
  ServerRequestListener,
  SubscriptionListener,
  ThreadState,
} from './state.js';
export type { CreateThreadsInput, ThreadAttachment } from './threads.js';
export type ThreadFeature = ReturnType<typeof createThreads>;
