import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCodingStorage,
  globalStateDatabasePath,
} from '../storage/index.js';

describe('global coding storage', () => {
  let oldHome: string | undefined;
  let home: string;

  beforeEach(async () => {
    oldHome = process.env.ELLO_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'ello-storage-'));
    process.env.ELLO_HOME = home;
  });

  afterEach(async () => {
    if (oldHome === undefined) {
      delete process.env.ELLO_HOME;
    } else {
      process.env.ELLO_HOME = oldHome;
    }
    await rm(home, { recursive: true, force: true });
  });

  it('只创建全局 state.sqlite，并启用关键 PRAGMA', async () => {
    const storage = createCodingStorage();
    try {
      expect(globalStateDatabasePath()).toBe(path.join(home, 'state.sqlite'));
      await expect(access(globalStateDatabasePath())).resolves.toBeUndefined();
      expect(storage.db.$client.pragma('foreign_keys', { simple: true })).toBe(
        1,
      );
      expect(storage.db.$client.pragma('busy_timeout', { simple: true })).toBe(
        5000,
      );
      expect(
        String(
          storage.db.$client.pragma('journal_mode', { simple: true }),
        ).toLowerCase(),
      ).toBe('wal');
      expect(
        storage.db.$client
          .prepare('select version, name from schema_migrations')
          .all(),
      ).toEqual([
        { version: 1, name: 'initial' },
        { version: 2, name: 'task-boards' },
      ]);
    } finally {
      storage.close();
    }
  });

  it('close 幂等，关闭后继续查询直接失败', () => {
    const storage = createCodingStorage();
    storage.close();
    storage.close();
    expect(() => storage.db.$client.prepare('select 1').get()).toThrow();
  });
});
