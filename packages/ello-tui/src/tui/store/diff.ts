import type { FileChange } from '../../api/protocol-types.js';

export type DiffLineKind = 'file' | 'hunk' | 'add' | 'del' | 'context' | 'meta';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldNo?: number;
  readonly newNo?: number;
}

export interface DiffSummary {
  readonly added: number;
  readonly removed: number;
}

export type PatchDiffRow =
  | { readonly kind: 'file'; readonly status: 'A' | 'D' | 'M' | 'R'; readonly path: string }
  | { readonly kind: 'hunk'; readonly text: string }
  | {
      readonly kind: 'line';
      readonly lineKind: 'add' | 'del' | 'context';
      readonly text: string;
      readonly oldNo?: number;
      readonly newNo?: number;
    };

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/** 把 Server 返回的 unified diff 解析为带双行号的展示行。 */
export function parseUnifiedDiff(diff: string): readonly DiffLine[] {
  if (diff.trim() === '') return [];
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split(/\r?\n/u)) {
    if (raw.startsWith('diff ') || raw.startsWith('index ')) {
      lines.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) {
      lines.push({ kind: 'file', text: raw });
      continue;
    }
    const hunk = HUNK_RE.exec(raw);
    if (hunk !== null) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), newNo });
      newNo += 1;
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1), oldNo });
      oldNo += 1;
    } else {
      lines.push({ kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
  }
  return lines;
}

export function summarizeDiff(diff: string | readonly FileChange[]): DiffSummary {
  if (typeof diff !== 'string') {
    return diff.reduce(
      (summary, change) => {
        const parsed = summarizeDiff(change.diff ?? '');
        return {
          added: summary.added + (change.additions ?? parsed.added),
          removed: summary.removed + (change.deletions ?? parsed.removed),
        };
      },
      { added: 0, removed: 0 },
    );
  }
  return parseUnifiedDiff(diff).reduce(
    (summary, line) => ({
      added: summary.added + (line.kind === 'add' ? 1 : 0),
      removed: summary.removed + (line.kind === 'del' ? 1 : 0),
    }),
    { added: 0, removed: 0 },
  );
}

export function readFileChanges(value: unknown): readonly FileChange[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!isFileChange(entry)) throw new Error('Invalid file change metadata.');
    return entry;
  });
}

export function unifiedDiffFromFileChanges(changes: readonly FileChange[]): string {
  return changes.map((change) => change.diff ?? '').filter((diff) => diff !== '').join('\n');
}

export function patchDiffRows(changes: readonly FileChange[]): readonly PatchDiffRow[] {
  const rows: PatchDiffRow[] = [];
  for (const change of changes) {
    rows.push({
      kind: 'file',
      status: change.kind === 'add' ? 'A' : change.kind === 'delete' ? 'D' : change.kind === 'rename' ? 'R' : 'M',
      path: change.kind === 'rename' && change.oldPath !== undefined ? `${change.oldPath} → ${change.path}` : change.path,
    });
    for (const line of parseUnifiedDiff(change.diff ?? '')) {
      if (line.kind === 'hunk') rows.push({ kind: 'hunk', text: line.text });
      else if (line.kind === 'add' || line.kind === 'del' || line.kind === 'context') {
        rows.push({
          kind: 'line',
          lineKind: line.kind,
          text: line.text,
          ...(line.oldNo === undefined ? {} : { oldNo: line.oldNo }),
          ...(line.newNo === undefined ? {} : { newNo: line.newNo }),
        });
      }
    }
  }
  return rows;
}

function isFileChange(value: unknown): value is FileChange {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === 'string' &&
    (record.kind === 'add' || record.kind === 'modify' || record.kind === 'delete' || record.kind === 'rename') &&
    (record.oldPath === undefined || typeof record.oldPath === 'string') &&
    (record.diff === undefined || typeof record.diff === 'string')
  );
}
