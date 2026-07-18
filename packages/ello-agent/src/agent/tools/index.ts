
import type { CodingAgentConfig } from '../../config/index.js';
import type { SessionModeState } from '../../domain/thread/session-mode.js';
import type { CodingStorage } from '../../storage/database/index.js';
import { createTaskService, type TaskBoardScope } from '../../storage/tasks/index.js';
import type { AnyAgentTool } from '../engine/index.js';
import {
  genericApprovalFor,
  makeApprovalPolicy,
  type DecideApproval,
} from '../permissions/policy.js';
import type { PermissionRule } from '../permissions/types.js';

import { createFsTools } from './fs.js';
import { adaptCodingTools } from './runtime/adapter.js';
import { SessionToolOutputStore } from './runtime/output-store.js';
import { createSearchTools } from './search.js';
import type { ApprovalFor } from './shared.js';
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
  readonly storage: CodingStorage;
  readonly taskBoardScope: TaskBoardScope;
  /** 动态权限规则读取器。 */
  readonly rules?: () => readonly PermissionRule[];
  readonly decide?: DecideApproval;
  readonly mode: () => SessionModeState;
  readonly readRoots?: () => readonly string[];
}

/**
 * 创建 coding-agent 默认工具集。
 *
 * 按域拆分：fs / search / shell / task。
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
  const tasks = createTaskService(
    options.storage.taskBoards,
    options.taskBoardScope,
  );

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

/** 生成工具列表的 CLI 视图（`ello tools` 与 `/tools` 用）。 */
export function describeCodingTools(tools: readonly AnyAgentTool[]): string {
  return tools
    .map((tool) => `${tool.name}\t${tool.description}\t${tool.discovery.risk}`)
    .join('\n');
}

export type { ApprovalFor } from './shared.js';
export type { DecideApproval } from '../permissions/policy.js';
