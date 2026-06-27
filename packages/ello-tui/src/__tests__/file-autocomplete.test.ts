import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyFileSuggestion,
  findActiveFileReference,
  suggestFileReferences,
} from '../file-autocomplete.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('file autocomplete', () => {
  it('detects the active @path token at the end of the composer', () => {
    expect(findActiveFileReference('read @src/in')).toMatchObject({
      raw: '@src/in',
      query: 'src/in',
    });
    expect(findActiveFileReference('read @src/in done')).toBeNull();
  });

  it('suggests directories before files and appends slash for directories', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ello-files-'));
    dirs.push(dir);
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'setup.ts'), '', 'utf8');
    await writeFile(path.join(dir, 'server.ts'), '', 'utf8');

    await expect(suggestFileReferences('open @s', dir)).resolves.toEqual([
      { label: 'dir @src/', replacement: '@src/', isDirectory: true },
      { label: 'file @server.ts', replacement: '@server.ts', isDirectory: false },
      { label: 'file @setup.ts', replacement: '@setup.ts', isDirectory: false },
    ]);
  });

  it('applies a suggestion to the active token only', () => {
    expect(
      applyFileSuggestion('read @sr', {
        label: 'dir @src/',
        replacement: '@src/',
        isDirectory: true,
      }),
    ).toBe('read @src/');
  });
});
