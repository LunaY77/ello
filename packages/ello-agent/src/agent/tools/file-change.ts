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
    return {
      kind: 'added',
      path: targetPath,
      after: next!,
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

export function createFileChanges(
  changes: readonly FileChange[],
): readonly FileChange[] {
  if (changes.length === 0) {
    throw new Error('File change list is empty.');
  }
  return changes;
}

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
