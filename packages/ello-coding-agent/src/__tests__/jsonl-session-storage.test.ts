import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMessageEntry } from '@ello/agent';
import { afterEach, describe, expect, it } from 'vitest';

import { JsonlSessionStorage } from '../jsonl-session-storage.js';
import { listJsonlSessions } from '../jsonl-session-storage.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('JsonlSessionStorage', () => {
  it('persists entries and leaf id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ello-session-'));
    dirs.push(dir);
    const first = await JsonlSessionStorage.open({ sessionDir: dir, sessionId: 's1' });
    const entry = createMessageEntry({ message: { role: 'user', content: 'hi' } });
    await first.appendEntry(entry);

    const second = await JsonlSessionStorage.open({ sessionDir: dir, sessionId: 's1' });

    await expect(second.getLeafId()).resolves.toBe(entry.id);
    await expect(second.getPathToRoot(entry.id)).resolves.toEqual([entry]);
  });

  it('lists session summaries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ello-session-'));
    dirs.push(dir);
    const store = await JsonlSessionStorage.open({ sessionDir: dir, sessionId: 's-list' });
    await store.appendEntry(createMessageEntry({ message: { role: 'user', content: 'hi' } }));

    await expect(listJsonlSessions(dir)).resolves.toMatchObject([
      { sessionId: 's-list', entryCount: 1 },
    ]);
  });

  it('persists latest task snapshot records', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ello-session-'));
    dirs.push(dir);
    const first = await JsonlSessionStorage.open({ sessionDir: dir, sessionId: 's-tasks' });
    await first.appendTaskSnapshot([{ id: 'task_1', status: 'pending' }]);
    await first.appendTaskSnapshot([{ id: 'task_1', status: 'completed' }]);

    const second = await JsonlSessionStorage.open({ sessionDir: dir, sessionId: 's-tasks' });

    expect(second.getLatestTaskSnapshot()).toEqual([
      { id: 'task_1', status: 'completed' },
    ]);
  });

  it('records branch metadata', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ello-session-'));
    dirs.push(dir);
    const store = await JsonlSessionStorage.open({ sessionDir: dir, sessionId: 'child' });
    await store.branchFrom('parent', 'leaf_1');

    const summary = await listJsonlSessions(dir);

    expect(summary[0]).toMatchObject({ branchOf: 'parent' });
  });
});
