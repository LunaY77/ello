/**
 * 本文件负责 tool feature 的“production”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { AnyAgentTool } from '../../agent/engine/index.js';
import type { CodingAgentConfig } from '../../config/index.js';
import type { TaskBoardStore, TaskBoardScope } from '../../task/index.js';
import {
  genericApprovalFor,
  makeApprovalPolicy,
  type ApprovalFor,
  type DecideApproval,
} from '../permissions/policy.js';
import type { SessionModeState } from '../permissions/session-mode.js';
import type { PermissionRule } from '../permissions/types.js';

import { createCodingTools } from './index.js';

export interface ProductionToolRuntime {
  readonly tools: readonly AnyAgentTool[];
  readonly approval: ApprovalFor;
}

export interface CreateProductionToolRuntimeOptions {
  readonly config: CodingAgentConfig;
  readonly taskBoards: TaskBoardStore;
  readonly taskBoardScope: TaskBoardScope;
  /**
   * 读取 工具 `production` 模块 的 `rules` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  readonly rules?: () => readonly PermissionRule[];
  /**
   * 执行 工具 `production` 模块 定义的 `mode` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回 `mode` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  readonly mode: () => SessionModeState;
  /**
   * 读取 工具 `production` 模块 的 `readRoots` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   *
   * Throws:
   * - 当 工具 `production` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  readonly readRoots?: () => readonly string[];
}

/**
 * 组装生产 Turn 的文件、Shell、搜索与任务工具，并暴露同一权限判定产生的通用审批能力。
 *
 * Args:
 * - `options`: 仅作用于 `createProductionToolRuntime` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回 `createProductionToolRuntime` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `production` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createProductionToolRuntime(
  options: CreateProductionToolRuntimeOptions,
): ProductionToolRuntime {
  const decide = createDecisionPolicy(options);
  const codingTools = createCodingTools({
    config: options.config,
    taskBoards: options.taskBoards,
    taskBoardScope: options.taskBoardScope,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    mode: options.mode,
    ...(options.readRoots === undefined
      ? {}
      : { readRoots: options.readRoots }),
    decide,
  }).map(markCoreTool);
  return {
    tools: codingTools,
    approval: genericApprovalFor(decide),
  };
}

/**
 * 按 工具 `production` 模块 的一致性约束执行 `markCoreTool` 状态变更。
 *
 * Args:
 * - `tool`: `markCoreTool` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `markCoreTool` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function markCoreTool(tool: AnyAgentTool): AnyAgentTool {
  return {
    ...tool,
    discovery: { ...tool.discovery, core: true },
  };
}

function createDecisionPolicy(
  options: CreateProductionToolRuntimeOptions,
): DecideApproval {
  return makeApprovalPolicy(
    options.config,
    options.rules ?? (() => []),
    options.mode,
    options.readRoots ?? (() => []),
  );
}
