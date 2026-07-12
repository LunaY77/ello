import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { AgentFileSystem } from '@ello/agent';
import { afterEach, describe, expect, it } from 'vitest';

import { parseApplyPatch, prepareApplyPatch } from '../tools/apply-patch.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('apply patch protocol', () => {
  it('parses add, delete, update, and move operations', () => {
    const patch = parseApplyPatch(`*** Begin Patch
*** Add File: new.txt
+new
*** Delete File: old.txt
*** Update File: src/a.txt
*** Move to: src/b.txt
@@ heading
-old
+updated
*** End Patch`);

    expect(patch.operations).toEqual([
      { kind: 'add', path: 'new.txt', content: 'new\n' },
      { kind: 'delete', path: 'old.txt' },
      {
        kind: 'update',
        path: 'src/a.txt',
        movePath: 'src/b.txt',
        chunks: [
          {
            changeContext: 'heading',
            oldLines: ['old'],
            newLines: ['updated'],
            isEndOfFile: false,
          },
        ],
      },
    ]);
  });

  it('rejects traditional unified diffs with an actionable error', () => {
    expect(() =>
      parseApplyPatch('--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new'),
    ).toThrow("first line must be '*** Begin Patch'");
  });

  it('accepts padded markers, an EOF marker, and a trailing newline', () => {
    const patch = parseApplyPatch(` *** Begin Patch
 *** Update File: a.txt
 @@
-old
+new
 *** End of File

 *** End Patch
`);

    expect(patch.operations[0]).toMatchObject({
      kind: 'update',
      path: 'a.txt',
      chunks: [{ isEndOfFile: true }],
    });
  });

  it('previews and atomically applies a multi-file patch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ello-apply-patch-'));
    dirs.push(root);
    await writeFile(join(root, 'delete.txt'), 'remove me\n');
    await writeFile(join(root, 'source.txt'), 'heading\nold value   \ntail\n');
    const fs = testFileSystem(root);
    const patch = parseApplyPatch(`*** Begin Patch
*** Add File: nested/new.txt
+created
*** Delete File: delete.txt
*** Update File: source.txt
*** Move to: moved/result.txt
@@ heading
-old value
+new value
*** End Patch`);

    const prepared = await prepareApplyPatch(fs, patch);
    expect(prepared.fileChanges.map((change) => change.kind)).toEqual([
      'added',
      'deleted',
      'modified',
    ]);
    expect(prepared.fileChanges[2]).toMatchObject({
      path: 'source.txt',
      movePath: 'moved/result.txt',
    });

    await prepared.apply();

    await expect(readFile(join(root, 'delete.txt'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(root, 'source.txt'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(root, 'nested/new.txt'), 'utf8')).resolves.toBe(
      'created\n',
    );
    await expect(
      readFile(join(root, 'moved/result.txt'), 'utf8'),
    ).resolves.toBe('heading\nnew value\ntail\n');
  });

  it('does not write any file when preview fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ello-apply-patch-'));
    dirs.push(root);
    await writeFile(join(root, 'keep.txt'), 'original\n');
    const fs = testFileSystem(root);
    const patch = parseApplyPatch(`*** Begin Patch
*** Add File: created.txt
+created
*** Update File: keep.txt
@@
-missing
+replacement
*** End Patch`);

    await expect(prepareApplyPatch(fs, patch)).rejects.toThrow(
      'Failed to find expected lines',
    );
    await expect(readFile(join(root, 'keep.txt'), 'utf8')).resolves.toBe(
      'original\n',
    );
    await expect(readFile(join(root, 'created.txt'), 'utf8')).rejects.toThrow();
  });
});

function testFileSystem(root: string): AgentFileSystem {
  const resolvePath = (targetPath: string) => resolve(root, targetPath);
  return {
    resolvePath,
    readText: (targetPath) => readFile(resolvePath(targetPath), 'utf8'),
    async writeText(targetPath, content) {
      const resolved = resolvePath(targetPath);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content);
    },
    listDir: async () => [],
  } as AgentFileSystem;
}
