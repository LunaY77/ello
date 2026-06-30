import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeCodingDatabase,
  globalStateDatabasePath,
  openGlobalCodingDatabase,
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
    const db = await openGlobalCodingDatabase();
    try {
      expect(globalStateDatabasePath()).toBe(path.join(home, 'state.sqlite'));
      await expect(access(globalStateDatabasePath())).resolves.toBeUndefined();
      expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.$client.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(
        String(
          db.$client.pragma('journal_mode', { simple: true }),
        ).toLowerCase(),
      ).toBe('wal');
    } finally {
      closeCodingDatabase(db);
    }
  });
});
