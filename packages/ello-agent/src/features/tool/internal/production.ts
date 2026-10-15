/**
 * 生产 Command runtime 的装配入口。
 *
 * 本模块只组合原生 Command definitions 与权限策略，不再创建或适配 Tool。
 */
import {
  defineCommandModule,
  type CommandDefinition,
  type CommandModule,
} from '../../command/index.js';
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

import type { SessionFileState } from './runtime/file-state.js';

import { createCodingCommands } from './index.js';

export interface ProductionCommandRuntime {
  readonly module: CommandModule;
  readonly approval: ApprovalFor;
}

export interface CreateProductionCommandRuntimeOptions {
  readonly config: CodingAgentConfig;
  readonly taskBoards: TaskBoardStore;
  readonly taskBoardScope: TaskBoardScope;
  /** 读取当前生效的权限规则。 */
  readonly rules?: () => readonly PermissionRule[];
  /** 读取当前 Session 权限模式。 */
  readonly mode: () => SessionModeState;
  /** 读取当前 Command 可访问的额外根目录。 */
  readonly readRoots?: () => readonly string[];
  readonly fileState?: SessionFileState;
  readonly additionalCommands?: readonly CommandDefinition[];
}

/**
 * 组装生产 Turn 的原生 Command 集合和通用审批能力。
 *
 * Args:
 * - `options`: 当前 run 的配置、权限、任务和扩展 Command 依赖。
 *
 * Returns:
 * - 返回 Registry 可直接消费的 Command definitions 与审批工厂。
 */
export function createProductionCommandRuntime(
  options: CreateProductionCommandRuntimeOptions,
): ProductionCommandRuntime {
  const decide = createDecisionPolicy(options);
  const additionalCommands = (options.additionalCommands ?? []).map((command) =>
    withAdditionalCommandApproval(command, decide),
  );
  return {
    module: defineCommandModule({
      id: 'coding',
      commands: createCodingCommands({
        config: options.config,
        taskBoards: options.taskBoards,
        taskBoardScope: options.taskBoardScope,
        ...(options.rules === undefined ? {} : { rules: options.rules }),
        mode: options.mode,
        ...(options.readRoots === undefined
          ? {}
          : { readRoots: options.readRoots }),
        ...(options.fileState === undefined
          ? {}
          : { fileState: options.fileState }),
        ...(additionalCommands.length === 0 ? {} : { additionalCommands }),
        decide,
      }),
    }),
    approval: genericApprovalFor(decide),
  };
}

function createDecisionPolicy(
  options: CreateProductionCommandRuntimeOptions,
): DecideApproval {
  return makeApprovalPolicy(
    options.config,
    options.rules ?? (() => []),
    options.mode,
    options.readRoots ?? (() => []),
  );
}

function withAdditionalCommandApproval(
  command: CommandDefinition,
  decide: DecideApproval,
): CommandDefinition {
  if (command.approval !== undefined) return command;
  return {
    ...command,
    approval: (input, context) => {
      const invocation = context.invocation;
      const readOnly =
        invocation?.readOnly === true && invocation.destructive === false;
      const permission = readOnly
        ? 'read'
        : command.name.startsWith('mcp__')
          ? 'mcp'
          : command.name;
      return decide(
        {
          permission,
          patterns: [command.name],
          always: [command.name],
          metadata: { kind: 'generic', inputPreview: previewInput(input) },
        },
        context,
      );
    },
  };
}

function previewInput(input: unknown): string {
  const value = JSON.stringify(input);
  if (value === undefined) return '-';
  return value.length > 200 ? `${value.slice(0, 200)}...` : value;
}
