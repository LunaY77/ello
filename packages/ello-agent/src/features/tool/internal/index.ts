/**
 * 本文件负责 tool feature 的公开入口与 factory。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { AnyAgentTool } from '../../agent/engine/index.js';
import type { CodingAgentConfig } from '../../config/index.js';
import type { TaskBoardStore } from '../../task/index.js';
import { createTaskService, type TaskBoardScope } from '../../task/index.js';
import {
  genericApprovalFor,
  makeApprovalPolicy,
  type ApprovalFor,
  type DecideApproval,
} from '../permissions/policy.js';
import type { SessionModeState } from '../permissions/session-mode.js';
import type { PermissionRule } from '../permissions/types.js';

import { createFsTools } from './fs.js';
import { adaptCodingTools } from './runtime/adapter.js';
import { SessionToolOutputStore } from './runtime/output-store.js';
import { createSearchTools } from './search.js';
import { createShellTools } from './shell.js';
import { createTaskTools } from './task.js';

/**
 * coding 工具集装配。
 *
 * 工具只做两件事：**纯执行** + **声明审批策略**。schema 校验、调度/并行、
 * 权限触发、事件发射全部由 `@ello/agent` 负责。
 * 审批策略 {@link makeApprovalPolicy}（按工具名 + 动态规则实时判定）。
 */
export interface CreateCodingToolsOptions {
  readonly config: CodingAgentConfig;
  readonly taskBoards: TaskBoardStore;
  readonly taskBoardScope: TaskBoardScope;
  /**
   * 动态权限规则读取器。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  readonly rules?: () => readonly PermissionRule[];
  readonly decide?: DecideApproval;
  /**
   * 执行 工具 公开入口 模块 定义的 `mode` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回 `mode` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  readonly mode: () => SessionModeState;
  /**
   * 读取 工具 公开入口 模块 的 `readRoots` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   *
   * Throws:
   * - 当 工具 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  readonly readRoots?: () => readonly string[];
}

/**
 * 创建 coding-agent 默认工具集。
 *
 * 按域拆分：fs / search / shell / task。
 *
 * Args:
 * - `options`: 仅作用于 `createCodingTools` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 *
 * Throws:
 * - 当 工具 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createCodingTools(
  options: CreateCodingToolsOptions,
): AnyAgentTool[] {
  const { config } = options;
  const decide =
    options.decide ??
    makeApprovalPolicy(
      config,
      options.rules ?? (() => []),
      options.mode,
      options.readRoots ?? (() => []),
    );
  const approval: ApprovalFor = genericApprovalFor(decide);
  const disabled = new Set(config.tools.disabled);
  const outputStore = new SessionToolOutputStore(config.session_dir);
  const tasks = createTaskService(options.taskBoards, options.taskBoardScope);

  const codingTools = [
    ...createFsTools(config, decide),
    ...createSearchTools(config, decide),
    ...createShellTools(config, decide),
  ];

  return [
    ...adaptCodingTools(codingTools, { config, outputStore }),
    ...createTaskTools(approval, tasks),
  ].filter((tool) => !disabled.has(tool.name));
}

/**
 * 生成工具列表的 CLI 视图（`ello tools` 与 `/tools` 用）。
 *
 * Args:
 * - `tools`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `describeCodingTools` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function describeCodingTools(tools: readonly AnyAgentTool[]): string {
  return tools
    .map((tool) => `${tool.name}\t${tool.description}\t${tool.discovery.risk}`)
    .join('\n');
}

export type { ApprovalFor, DecideApproval } from '../permissions/policy.js';
