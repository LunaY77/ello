import { describe, expect, it } from 'vitest';

import {
  InMemorySessionStorage,
  createCompactionEntry,
  createMessageEntry,
} from '../index.js';

describe('InMemorySessionStorage', () => {
  it('starts empty', async () => {
    const store = new InMemorySessionStorage();

    await expect(store.getLeafId()).resolves.toBeNull();
    await expect(store.getEntries()).resolves.toEqual([]);
  });

  it('appends and gets entries', async () => {
    const store = new InMemorySessionStorage();
    const entry = createMessageEntry({
      message: { role: 'user', content: 'hi' },
    });

    await store.appendEntry(entry);

    await expect(store.getLeafId()).resolves.toBe(entry.id);
    await expect(store.getEntry(entry.id)).resolves.toBe(entry);
  });

  it('builds parent chain and path to root', async () => {
    const store = new InMemorySessionStorage();
    const e1 = createMessageEntry({ message: { content: 'a' } });
    const e2 = createMessageEntry({ message: { content: 'b' } });

    await store.appendEntry(e1);
    await store.appendEntry(e2);

    expect(e2.parentId).toBe(e1.id);
    await expect(store.getPathToRoot(e2.id)).resolves.toEqual([e1, e2]);
  });

  it('sets leaf id and rejects unknown leaf', async () => {
    const store = new InMemorySessionStorage();
    const entry = createMessageEntry({ message: { content: 'a' } });
    await store.appendEntry(entry);

    await store.setLeafId(entry.id);
    await expect(store.getLeafId()).resolves.toBe(entry.id);
    await expect(store.setLeafId('nonexistent')).rejects.toThrow('not found');
  });

  it('returns metadata and entry count', async () => {
    const store = new InMemorySessionStorage({ sessionId: 'test-session-1' });

    const meta = await store.getMetadata();
    expect(meta.id).toBe('test-session-1');
    expect(meta.createdAt).toBeDefined();
    expect(store.entryCount).toBe(0);

    await store.appendEntry(
      createCompactionEntry({ summary: 'conversation summary' }),
    );
    expect(store.entryCount).toBe(1);
  });
});
