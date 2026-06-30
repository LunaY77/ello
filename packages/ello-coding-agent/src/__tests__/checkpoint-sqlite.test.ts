import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointStore } from '../change/checkpoint.js';
import { globalArtifactsDir } from '../storage/index.js';

describe('CheckpointStore SQLite backend', () => {
  let oldHome: string | undefined;
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    oldHome = process.env.ELLO_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'ello-checkpoint-home-'));
    cwd = await mkdtemp(path.join(tmpdir(), 'ello-checkpoint-cwd-'));
    process.env.ELLO_HOME = home;
  });

  afterEach(async () => {
    if (oldHome === undefined) {
      delete process.env.ELLO_HOME;
    } else {
      process.env.ELLO_HOME = oldHome;
    }
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('seal/list 使用全局 DB + artifacts，并能按 before 回滚', async () => {
    const target = path.join(cwd, 'note.txt');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'before\n', 'utf8');

    const store = new CheckpointStore(path.join(cwd, '.ello', 'checkpoints'));
    store.record({
      path: target,
      before: 'before\n',
      after: 'after\n',
      toolCallId: 'call-1',
      diff: 'diff',
    });
    await writeFile(target, 'after\n', 'utf8');

    const checkpoint = await store.seal('run-1', 'edit note');
    expect(checkpoint?.changes).toHaveLength(1);
    expect(await store.list()).toHaveLength(1);
    expect(globalArtifactsDir()).toBe(path.join(home, 'artifacts'));

    await store.rollback(checkpoint!.id);
    expect(await readFile(target, 'utf8')).toBe('before\n');
  });
});
