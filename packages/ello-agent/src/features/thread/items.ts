/**
 * 本文件负责 thread feature 的“items”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type {
  FileChange,
  ThreadItem,
  ThreadSnapshot,
  Turn,
} from '../../protocol/v1/index.js';
import { GoalSchema, PlanSchema } from '../../protocol/v1/index.js';

import { serializeJsonValue } from './records.js';

/**
 * 将工具事件投影为协议 ThreadItem；此层不参与 Agent stream 编排。
 *
 * Args:
 * - `id`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
 * - `turn`: `startedToolItem` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `name`: `startedToolItem` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `input`: `startedToolItem` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 * - `createdAt`: `startedToolItem` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `defaultCwd`: `startedToolItem` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `startedToolItem` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Thread `items` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function startedToolItem(
  id: string,
  turn: Turn,
  name: string,
  input: unknown,
  createdAt: string,
  defaultCwd: string,
): ThreadItem {
  const values = readRecord(input, `${name} input`);
  if (name === 'bash') {
    return {
      type: 'commandExecution',
      id,
      turnId: turn.id,
      createdAt,
      command: requireString(values.command, 'bash command'),
      cwd:
        values.cwd === undefined
          ? defaultCwd
          : requireString(values.cwd, 'bash cwd'),
      status: 'inProgress',
    };
  }
  if (['write', 'edit', 'apply_patch'].includes(name)) {
    return {
      type: 'fileChange',
      id,
      turnId: turn.id,
      createdAt,
      changes: [],
      status: 'inProgress',
    };
  }
  const serializedInput = serializeJsonValue(input);
  return {
    type: 'toolCall',
    id,
    turnId: turn.id,
    createdAt,
    toolName: name,
    headline: toolHeadline(name, input),
    status: 'inProgress',
    metadata: { input: serializedInput },
  };
}

/**
 * 在 Thread `items` 模块 中执行 `completedToolItem` 完整流程，并在返回前完成其必要副作用。
 *
 * Args:
 * - `item`: 要由 `completedToolItem` 读取或写入的单个领域值；所有权仍归调用方。
 * - `output`: `completedToolItem` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `_completedAt`: `completedToolItem` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `completedToolItem` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function completedToolItem(
  item: ThreadItem,
  output: unknown,
  _completedAt: string,
): ThreadItem {
  const result = codingToolResult(output);
  if (item.type === 'commandExecution') {
    if (result === undefined) {
      throw new Error(
        'Command tool output does not match the execution contract.',
      );
    }
    return {
      ...item,
      status: 'completed',
      outputPreview: result.output,
      exitCode: numberValue(result.metadata.exitCode),
      durationMs: nonNegativeNumber(result.metadata.durationMs),
    };
  }
  if (item.type === 'fileChange') {
    if (result === undefined) {
      throw new Error(
        'File change tool output does not match the execution contract.',
      );
    }
    return {
      ...item,
      status: 'completed',
      changes: fileChanges(result.metadata),
    };
  }
  if (item.type === 'toolCall') {
    return {
      ...item,
      status: 'completed',
      outputPreview: result?.output ?? preview(output),
    };
  }
  return completeItem(item);
}

/**
 * 在 Thread `items` 模块 中执行 `failItem` 完整流程，并在返回前完成其必要副作用。
 *
 * Args:
 * - `item`: 要由 `failItem` 读取或写入的单个领域值；所有权仍归调用方。
 * - `message`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
 *
 * Returns:
 * - 返回 `failItem` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function failItem(item: ThreadItem, message: string): ThreadItem {
  if (item.type === 'commandExecution') {
    return { ...item, status: 'failed', outputPreview: message };
  }
  if (item.type === 'fileChange' || item.type === 'toolCall') {
    return { ...item, status: 'failed' };
  }
  return item;
}

/**
 * 在 Thread `items` 模块 中执行 `completeItem` 完整流程，并在返回前完成其必要副作用。
 *
 * Args:
 * - `item`: 要由 `completeItem` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `completeItem` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function completeItem(item: ThreadItem): ThreadItem {
  switch (item.type) {
    case 'agentMessage':
    case 'reasoning':
    case 'plan':
    case 'commandExecution':
    case 'fileChange':
    case 'toolCall':
    case 'subagent':
    case 'contextCompaction':
      return { ...item, status: 'completed' };
    case 'userMessage':
    case 'notice':
    case 'error':
      return item;
    default:
      item satisfies never;
      throw new Error(`Unhandled thread item: ${String(item)}`);
  }
}

interface ProjectedCodingToolResult {
  readonly output: string;
  readonly metadata: Record<string, unknown>;
}

function codingToolResult(
  value: unknown,
): ProjectedCodingToolResult | undefined {
  if (!isRecord(value) || value.kind !== 'coding-tool-result') return undefined;
  if (typeof value.output !== 'string' || !isRecord(value.metadata)) {
    throw new Error('Coding tool result is missing output or metadata.');
  }
  return { output: value.output, metadata: value.metadata };
}

/**
 * 执行 Thread `items` 模块 定义的 `writtenPlan` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `value`: 要由 `writtenPlan` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
 */
export function writtenPlan(
  value: unknown,
): NonNullable<ThreadSnapshot['plan']> | undefined {
  if (!isRecord(value) || value.kind !== 'thread-plan-written')
    return undefined;
  return PlanSchema.parse(value.plan);
}

/**
 * 执行 Thread `items` 模块 定义的 `writtenGoal` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `value`: 要由 `writtenGoal` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
 */
export function writtenGoal(
  value: unknown,
): NonNullable<ThreadSnapshot['goal']> | undefined {
  if (!isRecord(value) || value.kind !== 'thread-goal-updated')
    return undefined;
  return GoalSchema.parse(value.goal);
}

interface ProjectableFileChange {
  readonly kind: 'added' | 'deleted' | 'modified';
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly unifiedDiff: string;
  readonly movePath?: string;
}

function fileChanges(metadata: Record<string, unknown>): readonly FileChange[] {
  const changes = metadata.fileChanges;
  if (
    !Array.isArray(changes) ||
    changes.length === 0 ||
    !changes.every(isProjectableFileChange)
  ) {
    throw new Error(
      'File change tool result has invalid fileChanges metadata.',
    );
  }
  return changes.map(projectFileChange);
}

function isProjectableFileChange(
  value: unknown,
): value is ProjectableFileChange {
  if (!isRecord(value)) return false;
  return (
    (value.kind === 'added' ||
      value.kind === 'deleted' ||
      value.kind === 'modified') &&
    typeof value.path === 'string' &&
    typeof value.additions === 'number' &&
    typeof value.deletions === 'number' &&
    typeof value.unifiedDiff === 'string' &&
    (value.movePath === undefined || typeof value.movePath === 'string')
  );
}

function projectFileChange(change: ProjectableFileChange): FileChange {
  const kind = change.kind;
  const common = {
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
    diff: change.unifiedDiff,
  };
  switch (kind) {
    case 'added':
      return { ...common, kind: 'add' };
    case 'deleted':
      return { ...common, kind: 'delete' };
    case 'modified':
      return change.movePath === undefined
        ? { ...common, kind: 'modify' }
        : {
            ...common,
            kind: 'rename',
            oldPath: change.path,
          };
    default:
      kind satisfies never;
      throw new Error('Unhandled file change kind.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function preview(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 4_000 ? `${text.slice(0, 4_000)}...` : text;
}

function toolHeadline(name: string, input: unknown): string {
  const text = preview(input);
  return text === '' ? name : `${name} ${text}`.slice(0, 240);
}
