import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ensureTaskCorpus } from '../src/infra/corpus/git-corpus.js';
import { runChecked } from '../src/infra/process.js';

const PROCESS_OPTIONS = {
  timeoutMs: 30_000,
  killGraceMs: 2_000,
  maxOutputBytes: 16 * 1024 * 1024,
} as const;

describe('task corpus checkout', () => {
  it('creates a clean checkout from an empty cache root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-corpus-'));
    const source = path.join(root, 'source');
    const checkout = path.join(root, 'cache', 'corpus');
    await git(['init', source], root);
    await git(['config', 'user.name', 'Ello Bench Test'], source);
    await git(['config', 'user.email', 'bench@example.invalid'], source);
    await writeFile(path.join(source, 'README.md'), 'fixture\n', 'utf8');
    await git(['add', 'README.md'], source);
    await git(['commit', '-m', 'fixture'], source);
    const revision = (await git(['rev-parse', 'HEAD'], source)).trim();

    const resolved = await ensureTaskCorpus({
      corpusRoot: checkout,
      source: {
        repository: pathToFileURL(source).href,
        revision,
      },
    });

    expect(resolved).toBe(checkout);
    expect(await readFile(path.join(checkout, 'README.md'), 'utf8')).toBe(
      'fixture\n',
    );
    expect(
      await git(['status', '--porcelain', '--untracked-files=no'], checkout),
    ).toBe('');

    await writeFile(
      path.join(checkout, 'unexpected.txt'),
      'unexpected\n',
      'utf8',
    );
    await expect(
      ensureTaskCorpus({
        corpusRoot: checkout,
        source: {
          repository: pathToFileURL(source).href,
          revision,
        },
      }),
    ).rejects.toThrow('Corpus checkout has changes');
  });
});

async function git(args: readonly string[], cwd: string): Promise<string> {
  return (
    await runChecked('git', args, {
      cwd,
      ...PROCESS_OPTIONS,
    })
  ).stdout;
}
