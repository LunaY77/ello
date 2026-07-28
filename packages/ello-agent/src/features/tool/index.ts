/**
 * 本文件负责 tool feature 的公开入口与 factory。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { TaskBoardStore } from '../task/index.js';

import { createToolRoutes, type LoadAdditionalTools } from './routes.js';

export interface CreateToolFeatureOptions {
  readonly loadAdditionalTools?: LoadAdditionalTools;
}

export { isPathInside, resolveAbsolute } from './permissions/engine.js';
export {
  projectApprovalItem,
  projectToolEvent,
} from './internal/event-projection.js';
export {
  createMetaToolRuntime,
  TOOL_ROUTING_INSTRUCTIONS,
} from './internal/meta-tools.js';
export {
  createProductionToolRuntime,
  markCoreTool,
} from './internal/production.js';
export type {
  CreateProductionToolRuntimeOptions,
  ProductionToolRuntime,
} from './internal/production.js';
export {
  SessionFileState,
  SessionFileStateRegistry,
} from './internal/runtime/file-state.js';
export {
  createCodingToolResult,
  defineCodingTool,
} from './internal/runtime/coding-tool.js';
export type {
  AnyCodingTool,
  CodingToolContext,
  CodingToolResult,
  ToolAttachment,
  ToolMetadata,
} from './internal/runtime/coding-tool.js';
export { RulesStore } from './permissions/rules-store.js';
export {
  genericApprovalFor,
  type ApprovalFor,
  type DecideApproval,
} from './permissions/policy.js';
export type {
  SessionMode,
  SessionModeState,
} from './permissions/session-mode.js';
export { PlanModeError } from './permissions/session-mode.js';
export type { PermissionRule } from './permissions/types.js';

/**
 * 构造 工具 公开入口 模块 中的 `createToolFeature` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `taskBoards`: `createToolFeature` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `options`: 可选的扩展工具加载函数；未提供时只注册内置工具。
 *
 * Returns:
 * - 返回 `createToolFeature` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createToolFeature(
  taskBoards: TaskBoardStore,
  options: CreateToolFeatureOptions = {},
) {
  return {
    routes: createToolRoutes(taskBoards, options.loadAdditionalTools),
  };
}
