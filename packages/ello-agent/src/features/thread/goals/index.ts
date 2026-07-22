/**
 * 本文件负责 thread feature 的公开入口与 factory。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
export {
  parseGoalSlashCommand,
  formatGoalStatus,
  goalUsage,
  type GoalCommand,
} from './controller.js';
export { createGoalSystemSection } from './prompt.js';
export { GoalService, type GoalPersistencePort } from './service.js';
export { createGoalTools, UPDATE_GOAL_DESCRIPTION } from './tools.js';
export type {
  GoalPauseReason,
  GoalState,
  GoalStatus,
  GoalStatusView,
  GoalUpdateResult,
} from './types.js';
