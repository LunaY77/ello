import { describe, expect, it } from 'vitest';

import { createFileChange } from '../tools/file-change.js';
import {
  patchDiffRows,
  parseUnifiedDiff,
  summarizeDiff,
} from '../tui/store/diff.js';

const DIFF = [
  'diff --git a/a.ts b/a.ts',
  'index 111..222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,4 @@',
  ' context',
  '-removed',
  '+added one',
  '+added two',
  ' tail',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('classifies meta, file, hunk, add, del and context lines', () => {
    const lines = parseUnifiedDiff(DIFF);
    const kinds = lines.map((line) => line.kind);
    expect(kinds).toEqual([
      'meta',
      'meta',
      'file',
      'file',
      'hunk',
      'context',
      'del',
      'add',
      'add',
      'context',
    ]);
  });

  it('assigns running old/new line numbers', () => {
    const lines = parseUnifiedDiff(DIFF);
    const firstContext = lines.find((line) => line.kind === 'context');
    expect(firstContext).toMatchObject({ oldNo: 1, newNo: 1 });
    const add = lines.find((line) => line.kind === 'add');
    expect(add?.newNo).toBe(2);
  });

  it('returns empty array for blank input', () => {
    expect(parseUnifiedDiff('   ')).toEqual([]);
  });
});

describe('summarizeDiff', () => {
  it('counts added and removed lines', () => {
    expect(summarizeDiff(DIFF)).toEqual({ added: 2, removed: 1 });
  });
});

describe('patchDiffRows', () => {
  it('renders file status, move path, and dual line numbers', () => {
    const rows = patchDiffRows([
      createFileChange(
        'src/old.ts',
        'first\nold\n',
        'first\nnew\nextra\n',
        'src/new.ts',
      ),
    ]);

    expect(rows[0]).toEqual({
      kind: 'file',
      status: 'R',
      path: 'src/old.ts → src/new.ts',
    });
    expect(rows).toContainEqual({
      kind: 'line',
      lineKind: 'del',
      text: 'old',
      oldNo: 2,
    });
    expect(rows).toContainEqual({
      kind: 'line',
      lineKind: 'add',
      text: 'new',
      newNo: 2,
    });
  });
});
