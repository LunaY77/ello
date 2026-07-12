import type { AnyAgentTool } from '@ello/agent';

import type { CodingAgentConfig } from '../config/index.js';
import {
  genericApprovalFor,
  makeApprovalPolicy,
  type DecideApproval,
} from '../permission/policy.js';
import type { PermissionRule } from '../permission/types.js';
import type { CodingStorage } from '../storage/index.js';
import { createTaskService, type TaskBoardScope } from '../tasks/index.js';

import { createFsTools } from './fs.js';
import { formatToolRegistry } from './registry.js';
import { adaptCodingTools } from './runtime/adapter.js';
import { SessionToolOutputStore } from './runtime/output-store.js';
import { createSearchTools } from './search.js';
import type { ApprovalFor } from './shared.js';
import { createShellTools } from './shell.js';
import { createTaskTools } from './task.js';
import { canFetch, webFetchTool } from './web.js';

/**
 * coding 工具集装配。
 *
 * 工具只做两件事：**纯执行** + **声明审批策略**。schema 校验、调度/并行、
 * 权限触发、事件发射全部由 `@ello/agent` 负责。
 * 审批策略 {@link makeApprovalPolicy}（按工具名 + 动态规则实时判定）。
 */
export interface CreateCodingToolsOptions {
  readonly config: CodingAgentConfig;
  readonly storage: CodingStorage;
  readonly taskBoardScope: TaskBoardScope;
  /** 动态权限规则读取器。 */
  readonly rules?: () => readonly PermissionRule[];
  readonly decide?: DecideApproval;
}

/**
 * 创建 coding-agent 默认工具集。
 *
 * 按域拆分：fs / search / shell / task；`web_fetch` 仅在可联网时注册。
 */
export function createCodingTools(
  options: CreateCodingToolsOptions,
): AnyAgentTool[] {
  const { config } = options;
  const decide =
    options.decide ?? makeApprovalPolicy(config, options.rules ?? (() => []));
  const approval: ApprovalFor = genericApprovalFor(decide);
  const disabled = new Set(config.tools.disabled);
  const outputStore = new SessionToolOutputStore(config.sessionDir);
  const tasks = createTaskService(
    options.storage.taskBoards,
    options.taskBoardScope,
  );

  const codingTools = [
    ...createFsTools(config, decide),
    ...createSearchTools(config, decide),
    ...createShellTools(config, decide),
    ...(canFetch(config) ? [webFetchTool(config, decide)] : []),
  ];

  return [
    ...adaptCodingTools(codingTools, { config, outputStore }),
    ...createTaskTools(approval, tasks),
  ].filter((tool) => !disabled.has(tool.name));
}

/** 生成工具列表的 CLI 视图（`ello tools` 与 `/tools` 用）。 */
export function describeCodingTools(): string {
  return formatToolRegistry();
}

export type { ApprovalFor } from './shared.js';
export type { DecideApproval } from '../permission/policy.js';
