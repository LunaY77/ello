/**
 * 统一 diff 解析。
 *
 * 对话历史里的 edit/write 改动使用结构化 FileChange 渲染文件块、双行号
 * gutter 与增删背景；历史兼容路径仍可解析 unified diff。审批弹窗只用
 * {@link summarizeDiff} 给出 +N/-M 摘要，不塞完整 diff。解析是纯函数，便于单测。
 */
import type { FileChange } from '../../tools/file-change.js';

export type DiffLineKind = 'file' | 'hunk' | 'add' | 'del' | 'context' | 'meta';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** 旧文件行号（context/del 行有值）。 */
  readonly oldNo?: number;
  /** 新文件行号（context/add 行有值）。 */
  readonly newNo?: number;
}

export interface DiffSummary {
  readonly added: number;
  readonly removed: number;
}

export type PatchDiffRow =
  | {
      readonly kind: 'file';
      readonly status: 'A' | 'D' | 'M' | 'R';
      readonly path: string;
    }
  | { readonly kind: 'hunk'; readonly text: string }
  | {
      readonly kind: 'line';
      readonly lineKind: 'add' | 'del' | 'context';
      readonly text: string;
      readonly oldNo?: number;
      readonly newNo?: number;
    };

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/** 把统一 diff 文本解析为带行号的结构化行。 */
export function parseUnifiedDiff(diff: string): readonly DiffLine[] {
  if (diff.trim() === '') {
    return [];
  }
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split(/\r?\n/u)) {
    if (raw.startsWith('diff ') || raw.startsWith('index ')) {
      out.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) {
      out.push({ kind: 'file', text: raw });
      continue;
    }
    const hunk = HUNK_RE.exec(raw);
    if (hunk !== null) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw, newNo });
      newNo += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw, oldNo });
      oldNo += 1;
      continue;
    }
    // 空串也算上下文行（diff 中的空行）。
    out.push({ kind: 'context', text: raw, oldNo, newNo });
    oldNo += 1;
    newNo += 1;
  }
  return out;
}

/** 统计增删行数，用于审批摘要。 */
export function summarizeDiff(
  diff: string | readonly FileChange[],
): DiffSummary {
  if (typeof diff !== 'string') {
    return diff.reduce(
      (acc, change) => ({
        added: acc.added + change.additions,
        removed: acc.removed + change.deletions,
      }),
      { added: 0, removed: 0 },
    );
  }
  let added = 0;
  let removed = 0;
  for (const line of parseUnifiedDiff(diff)) {
    if (line.kind === 'add') {
      added += 1;
    } else if (line.kind === 'del') {
      removed += 1;
    }
  }
  return { added, removed };
}

export function readFileChanges(value: unknown): readonly FileChange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    if (!isFileChange(entry)) {
      throw new Error('Invalid file change metadata.');
    }
    return entry;
  });
}

export function unifiedDiffFromFileChanges(
  changes: readonly FileChange[],
): string {
  return changes.map((change) => change.unifiedDiff).join('\n');
}

/** 将结构化文件变更转成文件块与双行号 diff 行。 */
export function patchDiffRows(
  changes: readonly FileChange[],
): readonly PatchDiffRow[] {
  const rows: PatchDiffRow[] = [];
  for (const change of changes) {
    rows.push({
      kind: 'file',
      status:
        change.kind === 'added'
          ? 'A'
          : change.kind === 'deleted'
            ? 'D'
            : change.movePath !== undefined
              ? 'R'
              : 'M',
      path:
        change.kind === 'modified' && change.movePath !== undefined
          ? `${change.path} → ${change.movePath}`
          : change.path,
    });
    for (const hunk of change.hunks) {
      rows.push({
        kind: 'hunk',
        text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      });
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.startsWith('+')) {
          rows.push({
            kind: 'line',
            lineKind: 'add',
            text: line.slice(1),
            newNo,
          });
          newNo += 1;
        } else if (line.startsWith('-')) {
          rows.push({
            kind: 'line',
            lineKind: 'del',
            text: line.slice(1),
            oldNo,
          });
          oldNo += 1;
        } else if (line.startsWith(' ')) {
          rows.push({
            kind: 'line',
            lineKind: 'context',
            text: line.slice(1),
            oldNo,
            newNo,
          });
          oldNo += 1;
          newNo += 1;
        }
      }
    }
  }
  return rows;
}

function isFileChange(value: unknown): value is FileChange {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as {
    kind?: unknown;
    path?: unknown;
    additions?: unknown;
    deletions?: unknown;
    hunks?: unknown;
    unifiedDiff?: unknown;
    movePath?: unknown;
  };
  return (
    (record.kind === 'added' ||
      record.kind === 'deleted' ||
      record.kind === 'modified') &&
    typeof record.path === 'string' &&
    typeof record.additions === 'number' &&
    typeof record.deletions === 'number' &&
    Array.isArray(record.hunks) &&
    typeof record.unifiedDiff === 'string' &&
    (record.movePath === undefined || typeof record.movePath === 'string')
  );
}
