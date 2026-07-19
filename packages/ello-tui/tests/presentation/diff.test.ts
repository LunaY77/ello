import { describe, expect, it } from 'vitest';

import type { FileChange } from '../../src/api/protocol-types.js';
import { createFileChange } from '../../src/testing/protocol-fixtures.js';
import {
  patchDiffRows,
  parseUnifiedDiff,
  readFileChanges,
  summarizeDiff,
  unifiedDiffFromFileChanges,
} from '../../src/tui/store/diff.js';

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

describe('统一 diff 解析', () => {
  it('区分元信息、文件、分块和内容行', () => {
    expect(parseUnifiedDiff(DIFF).map((line) => line.kind)).toEqual([
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

  it('分别维护新旧文件的连续行号', () => {
    const lines = parseUnifiedDiff(DIFF);

    expect(lines.find((line) => line.kind === 'context')).toMatchObject({
      oldNo: 1,
      newNo: 1,
    });
    expect(lines.find((line) => line.kind === 'del')).toMatchObject({
      oldNo: 2,
    });
    expect(lines.find((line) => line.kind === 'add')).toMatchObject({
      newNo: 2,
    });
  });

  it('空白输入不产生展示行或增删统计', () => {
    expect(parseUnifiedDiff('   ')).toEqual([]);
    expect(summarizeDiff('   ')).toEqual({ added: 0, removed: 0 });
  });

  it('汇总文本和协议文件变更中的增删数量', () => {
    expect(summarizeDiff(DIFF)).toEqual({ added: 2, removed: 1 });
    expect(
      summarizeDiff([
        { path: 'a.ts', kind: 'modify', additions: 4, deletions: 2 },
        { path: 'b.ts', kind: 'add', additions: 3, deletions: 0 },
      ]),
    ).toEqual({ added: 7, removed: 2 });
  });
});

describe('协议文件变更展示', () => {
  it('展示重命名路径、文件状态和双行号内容', () => {
    const change: FileChange = {
      ...createFileChange('src/new.ts', 'first\nold\n', 'first\nnew\nextra\n'),
      kind: 'rename',
      oldPath: 'src/old.ts',
    };
    const rows = patchDiffRows([change]);

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

  it('按协议顺序拼接非空 diff，并拒绝损坏的变更元数据', () => {
    const changes = [
      createFileChange('a.ts', 'old', 'new'),
      { path: 'b.ts', kind: 'modify' as const },
    ];

    expect(unifiedDiffFromFileChanges(changes)).toBe(changes[0]?.diff);
    expect(readFileChanges(changes)).toEqual(changes);
    expect(() => readFileChanges([{ path: '', kind: 'unknown' }])).toThrow(
      'Invalid file change metadata.',
    );
    expect(readFileChanges(undefined)).toEqual([]);
  });
});
