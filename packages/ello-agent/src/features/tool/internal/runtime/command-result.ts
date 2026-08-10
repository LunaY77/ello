/**
 * Command 执行结果的展示元数据与附件契约。
 *
 * 这些结构只描述执行输出，不参与 Command 定义、注册、输入解析或权限判断。
 */
import type { FileChange } from '../file-change.js';

export type CommandResultMetadataKind =
  | 'read'
  | 'search'
  | 'edit'
  | 'shell'
  | 'network'
  | 'task'
  | 'workspace'
  | 'generic';

export interface CommandResultMetadata {
  /** 元数据服务于 TUI、权限弹窗和日志展示，不作为模型语义判断来源。 */
  readonly kind: CommandResultMetadataKind;
  readonly summary?: string;
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly command?: string;
  readonly cwd?: string;
  readonly url?: string;
  readonly domain?: string;
  readonly fileChanges?: readonly FileChange[];
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly truncated?: boolean;
  readonly outputPath?: string;
  readonly [key: string]: unknown;
}

export interface CommandAttachment {
  readonly type: 'text' | 'image' | 'pdf' | 'binary';
  readonly mime: string;
  readonly path?: string;
  readonly name?: string;
  readonly bytes?: number;
  readonly content?: string;
}

export interface CommandResult {
  readonly kind: 'command-result';
  readonly title: string;
  readonly output: string;
  readonly metadata: CommandResultMetadata;
  readonly attachments?: readonly CommandAttachment[];
}

/**
 * 构造携带展示元数据和可选附件的 Command 结果。
 *
 * Args:
 * - `input`: Command 输出、标题、元数据和附件。
 *
 * Returns:
 * - 返回具有稳定 `command-result` 判别字段的不可变结果。
 */
export function createCommandResult(input: {
  readonly title: string;
  readonly output: string;
  readonly metadata: CommandResultMetadata;
  readonly attachments?: readonly CommandAttachment[];
}): CommandResult {
  return {
    kind: 'command-result',
    title: input.title,
    output: input.output,
    metadata: input.metadata,
    ...(input.attachments === undefined
      ? {}
      : { attachments: input.attachments }),
  };
}
