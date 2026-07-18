import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCodingStorage } from '../storage/database/index.js';
import { stateDatabasePath } from '../storage/paths.js';

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

  it('只创建全局 state/ello.sqlite，并启用关键 PRAGMA', async () => {
    const storage = createCodingStorage();
    try {
      expect(stateDatabasePath()).toBe(path.join(home, 'state', 'ello.sqlite'));
      await expect(access(stateDatabasePath())).resolves.toBeUndefined();
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
      const migration = await readFile(
        new URL(
          '../storage/migrations/0000_tiny_swordsman.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const journal = JSON.parse(
        await readFile(
          new URL('../storage/migrations/meta/_journal.json', import.meta.url),
          'utf8',
        ),
      ) as { readonly entries: readonly { readonly when: number }[] };
      expect(
        storage.db.$client
          .prepare(
            'select hash, created_at as createdAt from __drizzle_migrations',
          )
          .all(),
      ).toEqual([
        {
          hash: createHash('sha256').update(migration).digest('hex'),
          createdAt: journal.entries[0]!.when,
        },
      ]);
      expect(
        storage.db.$client
          .prepare(
            `select name from sqlite_master
             where type = 'table' and name in ('memory_items', 'memory_access_log')`,
          )
          .all(),
      ).toEqual([]);
      expect(
        storage.db.$client
          .prepare(
            `select name from sqlite_master
             where type = 'trigger'
             order by name`,
          )
          .all(),
      ).toEqual([
        { name: 'workspace_repositories_checkout_mode_insert' },
        { name: 'workspace_repositories_checkout_mode_update' },
        { name: 'workspace_repositories_checkout_role_insert' },
        { name: 'workspace_repositories_checkout_role_update' },
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
