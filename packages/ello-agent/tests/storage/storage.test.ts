/**
 * 本文件验证 storage 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stateDatabasePath } from '../../src/infra/paths.js';
import { createTestStores } from '../support/stores.js';

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
    const storage = createTestStores();
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
      const journal = JSON.parse(
        await readFile(
          new URL(
            '../../src/infra/database/migrations/meta/_journal.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as {
        readonly entries: readonly {
          readonly tag: string;
          readonly when: number;
        }[];
      };
      const expectedMigrations = await Promise.all(
        journal.entries.map(async (entry) => {
          const migration = await readFile(
            new URL(
              `../../src/infra/database/migrations/${entry.tag}.sql`,
              import.meta.url,
            ),
          );
          return {
            hash: createHash('sha256').update(migration).digest('hex'),
            createdAt: entry.when,
          };
        }),
      );
      expect(
        storage.db.$client
          .prepare(
            'select hash, created_at as createdAt from __drizzle_migrations',
          )
          .all(),
      ).toEqual(expectedMigrations);
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
             where type = 'table'
               and name in ('checkpoints', 'checkpoint_file_changes', 'checkpoint_rollbacks')`,
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
    const storage = createTestStores();
    storage.close();
    storage.close();
    expect(() => storage.db.$client.prepare('select 1').get()).toThrow();
  });

  it('从旧数据库升级时删除文件改动 checkpoint，并允许回收遗留 artifact', async () => {
    const databasePath = stateDatabasePath();
    const artifactRoot = path.join(home, 'artifacts');
    const artifactPath = path.join(artifactRoot, 'ab', 'legacy-artifact');
    const migrationUrl = new URL(
      '../../src/infra/database/migrations/0000_tiny_swordsman.sql',
      import.meta.url,
    );
    const migration = await readFile(migrationUrl, 'utf8');
    const journal = JSON.parse(
      await readFile(
        new URL(
          '../../src/infra/database/migrations/meta/_journal.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { readonly entries: readonly { readonly when: number }[] };

    await mkdir(path.dirname(databasePath), { recursive: true });
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, 'legacy checkpoint', 'utf8');
    const database = new Database(databasePath);
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim() !== '') database.exec(statement);
    }
    database.exec(`
      create table __drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at numeric
      )
    `);
    database
      .prepare(
        'insert into __drizzle_migrations (hash, created_at) values (?, ?)',
      )
      .run(
        createHash('sha256').update(migration).digest('hex'),
        journal.entries[0]!.when,
      );
    database
      .prepare(
        `insert into artifacts
          (id, kind, path, sha256, byte_size, content_type, created_at)
         values (?, 'checkpoint', ?, ?, ?, 'text/plain', ?)`,
      )
      .run(
        'legacy-artifact',
        artifactPath,
        'legacy-sha256',
        Buffer.byteLength('legacy checkpoint'),
        '2026-01-01T00:00:00.000Z',
      );
    database
      .prepare(
        `insert into artifact_references
          (artifact_id, owner_kind, owner_id, relation, created_at)
         values ('legacy-artifact', 'checkpoint', 'checkpoint-1', 'before', ?)`,
      )
      .run('2026-01-01T00:00:00.000Z');
    database
      .prepare(
        `insert into checkpoints (id, run_id, status, created_at)
         values ('checkpoint-1', 'run-1', 'sealed', ?)`,
      )
      .run('2026-01-01T00:00:00.000Z');
    database
      .prepare(
        `insert into checkpoint_file_changes
          (id, checkpoint_id, path, path_hash, change_type, before_artifact_id, created_at)
         values ('change-1', 'checkpoint-1', '/repo/file.ts', 'path-hash', 'modified', 'legacy-artifact', ?)`,
      )
      .run('2026-01-01T00:00:00.000Z');
    database
      .prepare(
        `insert into checkpoint_rollbacks
          (id, checkpoint_id, run_id, status, created_at)
         values ('rollback-1', 'checkpoint-1', 'run-1', 'completed', ?)`,
      )
      .run('2026-01-01T00:00:00.000Z');
    database.close();

    const storage = createTestStores({ databasePath, artifactsDir: artifactRoot });
    try {
      expect(
        storage.db.$client
          .prepare(
            `select name from sqlite_master
             where type = 'table'
               and name in ('checkpoints', 'checkpoint_file_changes', 'checkpoint_rollbacks')`,
          )
          .all(),
      ).toEqual([]);
      expect(
        storage.db.$client
          .prepare(
            "select count(*) as count from artifact_references where owner_kind = 'checkpoint'",
          )
          .get(),
      ).toEqual({ count: 0 });
      await expect(access(artifactPath)).resolves.toBeUndefined();
      await expect(storage.artifacts.deleteUnreferenced()).resolves.toEqual({
        deleted: 1,
        bytesFreed: Buffer.byteLength('legacy checkpoint'),
      });
      await expect(access(artifactPath)).rejects.toThrow();
    } finally {
      storage.close();
    }
  });

  it('历史 migration checksum 被改写时拒绝启动', () => {
    const storage = createTestStores();
    storage.db.$client
      .prepare('update __drizzle_migrations set hash = ?')
      .run('tampered');
    storage.close();

    expect(() => createTestStores()).toThrow('migration checksum mismatch');
  });

  it('数据库包含未来 migration 时拒绝由旧 Server 打开', () => {
    const storage = createTestStores();
    storage.close();
    const database = new Database(stateDatabasePath());
    database
      .prepare(
        'insert into __drizzle_migrations (hash, created_at) values (?, ?)',
      )
      .run('future', Date.now() + 1_000_000);
    database.close();

    expect(() => createTestStores()).toThrow('migration version is newer');
  });
});
