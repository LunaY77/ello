/**
 * 本文件负责 agent feature 的“recording”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import path from 'node:path';

import type { CheckpointStore, FileChange } from './checkpoint.js';

/**
 * 只在工具成功返回结构化 fileChanges 后记录，失败或普通输出不产生检查点。
 *
 * Args:
 * - `input`: `recordCheckpointChanges` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 产品 Agent `recording` 模块 的同步状态变更完成后返回，不产生业务结果。
 */
export function recordCheckpointChanges(input: {
  readonly checkpoints: CheckpointStore;
  readonly cwd: string;
  readonly toolCallId: string;
  readonly output: unknown;
}): void {
  const changes = codingToolFileChanges(input.output);
  if (changes === undefined) return;
  for (const change of changes) {
    for (const checkpointChange of toCheckpointChanges(
      input.cwd,
      input.toolCallId,
      change,
    )) {
      input.checkpoints.record(checkpointChange);
    }
  }
}

function codingToolFileChanges(
  output: unknown,
): ReadonlyArray<unknown> | undefined {
  if (!isRecord(output) || output.kind !== 'coding-tool-result') {
    return undefined;
  }
  if (!isRecord(output.metadata)) {
    throw new Error('Coding tool result metadata must be an object.');
  }
  const changes = output.metadata.fileChanges;
  if (changes === undefined) {
    return undefined;
  }
  if (!Array.isArray(changes)) {
    throw new Error('Coding tool fileChanges metadata must be an array.');
  }
  return changes;
}

function toCheckpointChanges(
  cwd: string,
  toolCallId: string,
  value: unknown,
): readonly FileChange[] {
  if (!isFileChange(value)) {
    throw new Error('Invalid file change metadata returned by a coding tool.');
  }
  const target = absolute(cwd, value.path);
  switch (value.kind) {
    case 'added':
      return [change(target, null, value.after, toolCallId, value.unifiedDiff)];
    case 'deleted':
      return [
        change(target, value.before, null, toolCallId, value.unifiedDiff),
      ];
    case 'modified':
      if (value.movePath === undefined) {
        return [
          change(
            target,
            value.before,
            value.after,
            toolCallId,
            value.unifiedDiff,
          ),
        ];
      }
      return [
        change(target, value.before, null, toolCallId, value.unifiedDiff),
        change(
          absolute(cwd, value.movePath),
          null,
          value.after,
          toolCallId,
          value.unifiedDiff,
        ),
      ];
    default:
      value satisfies never;
      throw new Error('Unhandled file change kind.');
  }
}

function change(
  filePath: string,
  before: string | null,
  after: string | null,
  toolCallId: string,
  diff: string,
): FileChange {
  return { path: filePath, before, after, toolCallId, diff };
}

function absolute(cwd: string, target: string): string {
  return path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(cwd, target);
}

function isFileChange(value: unknown): value is
  | {
      readonly kind: 'added';
      readonly path: string;
      readonly after: string;
      readonly unifiedDiff: string;
    }
  | {
      readonly kind: 'deleted';
      readonly path: string;
      readonly before: string;
      readonly unifiedDiff: string;
    }
  | {
      readonly kind: 'modified';
      readonly path: string;
      readonly before: string;
      readonly after: string;
      readonly movePath?: string;
      readonly unifiedDiff: string;
    } {
  if (!isRecord(value)) return false;
  if (
    !['added', 'deleted', 'modified'].includes(String(value.kind)) ||
    typeof value.path !== 'string' ||
    typeof value.unifiedDiff !== 'string'
  ) {
    return false;
  }
  if (value.kind === 'added') return typeof value.after === 'string';
  if (value.kind === 'deleted') return typeof value.before === 'string';
  return (
    value.kind === 'modified' &&
    typeof value.before === 'string' &&
    typeof value.after === 'string' &&
    (value.movePath === undefined || typeof value.movePath === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
