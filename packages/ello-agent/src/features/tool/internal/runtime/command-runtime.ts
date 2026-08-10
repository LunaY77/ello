/**
 * Coding Command 的输出、文件状态和失败跟踪中间件。
 *
 * 该模块增强原生 Command execution，不转换定义类型，也不参与输入解析或 Catalog 注册。
 */
import path from 'node:path';

import type { CommandDefinition } from '../../../command/index.js';
import type { CodingAgentConfig } from '../../../config/index.js';

import {
  duplicateCommandNotice,
  ShellCommandHistory,
} from './command-history.js';
import type { CommandResult } from './command-result.js';
import type { SessionFileState } from './file-state.js';
import {
  persistLargeOutput,
  type CommandOutputLimits,
  type CommandOutputStore,
} from './output-store.js';
import { CommandFailureTracker } from './tool-errors.js';

export interface CommandOutputRuntimeOptions {
  readonly config: CodingAgentConfig;
  readonly outputStore: CommandOutputStore;
  readonly commandHistory: ShellCommandHistory;
  readonly fileState: SessionFileState;
  readonly failures: CommandFailureTracker;
}

/**
 * 给一个原生 Command 附加统一的大输出、文件失效和失败诊断行为。
 *
 * Args:
 * - `command`: 已经完成 invocation 与领域执行声明的 Command。
 * - `options`: 当前运行共享的输出和文件状态依赖。
 *
 * Returns:
 * - 返回保持同一 Command identity 的增强定义。
 */
export function attachCommandOutputRuntime(
  command: CommandDefinition,
  options: CommandOutputRuntimeOptions,
): CommandDefinition {
  if (command.execution.kind === 'deferred') return command;
  const run = command.execution.run;
  return {
    ...command,
    execution: {
      kind: 'immediate',
      run: async (input, context) => {
        let result: unknown;
        try {
          result = await run(input, context);
        } catch (error) {
          throw options.failures.create(command.name, error);
        }
        if (!isCommandResult(result)) return result;
        invalidateChangedFiles(
          options.fileState,
          options.config.cwd,
          result.metadata.fileChanges,
        );
        const notice = recordRound(options.commandHistory, result.metadata);
        const output =
          notice === undefined ? result.output : `${notice}\n${result.output}`;
        const persisted = await persistLargeOutput({
          output,
          limits: outputLimits(options.config),
          store: options.outputStore,
          sessionId: readString(context.metadata.sessionId) ?? 'default',
          runId: context.runId,
          callId: context.commandId,
          preferredName: `${command.name}.txt`,
        });
        if (!persisted.truncated) return { ...result, output };
        return {
          ...result,
          output: persisted.output,
          metadata: {
            ...result.metadata,
            truncated: true,
            outputPath: persisted.outputPath,
          },
        };
      },
    },
  };
}

function isCommandResult(value: unknown): value is CommandResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'kind') === 'command-result' &&
    typeof Reflect.get(value, 'output') === 'string' &&
    typeof Reflect.get(value, 'metadata') === 'object' &&
    Reflect.get(value, 'metadata') !== null
  );
}

function invalidateChangedFiles(
  fileState: SessionFileState,
  cwd: string,
  changes: CommandResult['metadata']['fileChanges'],
): void {
  if (changes === undefined || changes.length === 0) return;
  fileState.invalidate(
    changes.flatMap((change) => [
      path.resolve(cwd, change.path),
      ...(change.kind === 'modified' && change.movePath !== undefined
        ? [path.resolve(cwd, change.movePath)]
        : []),
    ]),
  );
}

function recordRound(
  history: ShellCommandHistory,
  metadata: CommandResult['metadata'],
): string | undefined {
  if (metadata.kind === 'shell') {
    const command = metadata.command;
    if (typeof command !== 'string') {
      throw new Error('Shell Command result metadata is missing its command.');
    }
    const duplicate = history.recordCommand(command);
    return duplicate === null ? undefined : duplicateCommandNotice(duplicate);
  }
  if (metadata.fileChanges !== undefined && metadata.fileChanges.length > 0) {
    history.recordFileChange();
    return undefined;
  }
  history.recordOtherCall();
  return undefined;
}

function outputLimits(config: CodingAgentConfig): CommandOutputLimits {
  return {
    maxBytes: config.tool_output.max_bytes,
    maxLines: config.tool_output.max_lines,
    previewLines: config.tool_output.preview_lines,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
