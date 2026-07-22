/**
 * 本文件负责 tool feature 的“file-change”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { formatPatch, structuredPatch, type StructuredPatch } from 'diff';

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

export type FileChange =
  | {
      readonly kind: 'added';
      readonly path: string;
      readonly after: string;
      readonly additions: number;
      readonly deletions: 0;
      readonly hunks: readonly DiffHunk[];
      readonly unifiedDiff: string;
    }
  | {
      readonly kind: 'deleted';
      readonly path: string;
      readonly before: string;
      readonly additions: 0;
      readonly deletions: number;
      readonly hunks: readonly DiffHunk[];
      readonly unifiedDiff: string;
    }
  | {
      readonly kind: 'modified';
      readonly path: string;
      readonly before: string;
      readonly after: string;
      readonly additions: number;
      readonly deletions: number;
      readonly hunks: readonly DiffHunk[];
      readonly unifiedDiff: string;
      readonly movePath?: string;
    };

/**
 * 构造 工具 `file-change` 模块 中的 `createFileChange` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `targetPath`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `previous`: `createFileChange` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `next`: `createFileChange` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `movePath`: `createFileChange` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
 *
 * Returns:
 * - 返回 `createFileChange` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `file-change` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createFileChange(
  targetPath: string,
  previous: string | null,
  next: string | null,
  movePath?: string,
): FileChange {
  if (previous === null && next === null) {
    throw new Error(`Cannot create empty file change for ${targetPath}.`);
  }
  const oldName = previous === null ? '/dev/null' : targetPath;
  const newName = next === null ? '/dev/null' : (movePath ?? targetPath);
  const patch = structuredPatch(
    oldName,
    newName,
    previous ?? '',
    next ?? '',
    undefined,
    undefined,
    { context: 3 },
  );
  const hunks = patch.hunks.map(toDiffHunk);
  const summary = summarizeHunks(hunks);
  const unifiedDiff = formatPatch(patch).trimEnd();
  if (previous === null) {
    if (next === null) {
      throw new Error(`Added file change is missing content: ${targetPath}.`);
    }
    return {
      kind: 'added',
      path: targetPath,
      after: next,
      additions: summary.additions,
      deletions: 0,
      hunks,
      unifiedDiff,
    };
  }
  if (next === null) {
    return {
      kind: 'deleted',
      path: targetPath,
      before: previous,
      additions: 0,
      deletions: summary.deletions,
      hunks,
      unifiedDiff,
    };
  }
  return {
    kind: 'modified',
    path: targetPath,
    before: previous,
    after: next,
    additions: summary.additions,
    deletions: summary.deletions,
    hunks,
    unifiedDiff,
    ...(movePath !== undefined ? { movePath } : {}),
  };
}

/**
 * 构造 工具 `file-change` 模块 中的 `createFileChanges` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `changes`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 *
 * Throws:
 * - 当 工具 `file-change` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createFileChanges(
  changes: readonly FileChange[],
): readonly FileChange[] {
  if (changes.length === 0) {
    throw new Error('File change list is empty.');
  }
  return changes;
}

/**
 * 执行 工具 `file-change` 模块 定义的 `summarizeFileChanges` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `changes`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `summarizeFileChanges` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function summarizeFileChanges(changes: readonly FileChange[]): {
  readonly additions: number;
  readonly deletions: number;
} {
  return changes.reduce(
    (acc, change) => ({
      additions: acc.additions + change.additions,
      deletions: acc.deletions + change.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

/**
 * 执行 工具 `file-change` 模块 定义的 `unifiedDiffFromChanges` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `changes`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `unifiedDiffFromChanges` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function unifiedDiffFromChanges(changes: readonly FileChange[]): string {
  return changes.map((change) => change.unifiedDiff).join('\n');
}

function toDiffHunk(hunk: StructuredPatch['hunks'][number]): DiffHunk {
  return {
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
  };
}

function summarizeHunks(hunks: readonly DiffHunk[]): {
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        additions += 1;
      } else if (line.startsWith('-')) {
        deletions += 1;
      }
    }
  }
  return { additions, deletions };
}
