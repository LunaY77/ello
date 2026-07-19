import path from 'node:path';

import type { ToolMetadata } from '../tools/runtime/coding-tool.js';

import type { CheckpointStore, FileChange } from './checkpoint.js';

/** 只在工具成功返回结构化 fileChanges 后记录，失败或普通输出不产生检查点。 */
export function recordCheckpointChanges(input: {
  readonly checkpoints: CheckpointStore;
  readonly cwd: string;
  readonly toolCallId: string;
  readonly output: unknown;
}): void {
  const metadata = codingToolMetadata(input.output);
  const changes = metadata?.fileChanges;
  if (!Array.isArray(changes)) return;
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

function codingToolMetadata(output: unknown): ToolMetadata | undefined {
  if (
    typeof output !== 'object' ||
    output === null ||
    (output as { readonly kind?: unknown }).kind !== 'coding-tool-result'
  ) {
    return undefined;
  }
  return (output as { readonly metadata?: ToolMetadata }).metadata;
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
  if (value.kind === 'added') {
    return [change(target, null, value.after, toolCallId, value.unifiedDiff)];
  }
  if (value.kind === 'deleted') {
    return [change(target, value.before, null, toolCallId, value.unifiedDiff)];
  }
  if (value.movePath === undefined) {
    return [
      change(target, value.before, value.after, toolCallId, value.unifiedDiff),
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
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    !['added', 'deleted', 'modified'].includes(String(candidate.kind)) ||
    typeof candidate.path !== 'string' ||
    typeof candidate.unifiedDiff !== 'string'
  ) {
    return false;
  }
  if (candidate.kind === 'added') return typeof candidate.after === 'string';
  if (candidate.kind === 'deleted') return typeof candidate.before === 'string';
  return (
    typeof candidate.before === 'string' &&
    typeof candidate.after === 'string' &&
    (candidate.movePath === undefined || typeof candidate.movePath === 'string')
  );
}
