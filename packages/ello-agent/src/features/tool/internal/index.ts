/**
 * 文件、搜索、Shell、workspace 与任务 Command 的生产装配。
 *
 * Feature factory 只返回 Command 原生定义；Registry 负责解析、Catalog 和运行生命周期。
 */
import type { CommandDefinition } from '../../command/index.js';
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

import { createFsCommands } from './fs.js';
import { ShellCommandHistory } from './runtime/command-history.js';
import { attachCommandOutputRuntime } from './runtime/command-runtime.js';
import { SessionFileState } from './runtime/file-state.js';
import { SessionCommandOutputStore } from './runtime/output-store.js';
import { CommandFailureTracker } from './runtime/tool-errors.js';
import { createSearchCommands } from './search.js';
import { createShellCommands } from './shell.js';
import { createTaskCommands } from './task.js';

export interface CreateCodingCommandsOptions {
  readonly config: CodingAgentConfig;
  readonly taskBoards: TaskBoardStore;
  readonly taskBoardScope: TaskBoardScope;
  /** 读取当前生效的权限规则。 */
  readonly rules?: () => readonly PermissionRule[];
  readonly decide?: DecideApproval;
  /** 读取当前 Session 权限模式。 */
  readonly mode: () => SessionModeState;
  /** 读取当前 Command 可访问的额外根目录。 */
  readonly readRoots?: () => readonly string[];
  readonly fileState?: SessionFileState;
  readonly additionalCommands?: readonly CommandDefinition[];
}

/**
 * 创建 coding Agent 的原生 Command 集合。
 *
 * Args:
 * - `options`: 当前 run 的配置、权限、任务和动态扩展依赖。
 *
 * Returns:
 * - 返回已经附加统一输出行为并按 disabled 配置过滤的定义集合。
 */
export function createCodingCommands(
  options: CreateCodingCommandsOptions,
): CommandDefinition[] {
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
  const disabled = new Set(config.commands.disabled);
  const outputStore = new SessionCommandOutputStore(config.session_dir);
  const tasks = createTaskService(options.taskBoards, options.taskBoardScope);
  const commandHistory = new ShellCommandHistory();
  const failures = new CommandFailureTracker();
  const fileState = options.fileState ?? new SessionFileState();
  const executionCommands = [
    ...createFsCommands(config, decide, fileState),
    ...createSearchCommands(config, decide),
    ...createShellCommands(config, decide),
    ...(options.additionalCommands ?? []),
  ].map((command) =>
    attachCommandOutputRuntime(command, {
      config,
      outputStore,
      commandHistory,
      fileState,
      failures,
    }),
  );
  return [...executionCommands, ...createTaskCommands(approval, tasks)].filter(
    (command) => !disabled.has(command.name),
  );
}

/**
 * 生成 Command Catalog 的 CLI 视图。
 *
 * Args:
 * - `commands`: 当前配置装配出的 Command definitions。
 *
 * Returns:
 * - 返回名称、摘要和风险组成的稳定文本列表。
 */
export function describeCommands(
  commands: readonly CommandDefinition[],
): string {
  return commands
    .map((command) => `${command.name}\t${command.summary}\t${command.risk}`)
    .join('\n');
}

export type { ApprovalFor, DecideApproval } from '../permissions/policy.js';
