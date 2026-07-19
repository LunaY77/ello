import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCodingStorage } from '../../src/storage/database/index.js';
import {
  legacyStateDatabasePath,
  stateDatabasePath,
} from '../../src/storage/paths.js';

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
          '../../src/storage/migrations/0000_tiny_swordsman.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const journal = JSON.parse(
        await readFile(
          new URL(
            '../../src/storage/migrations/meta/_journal.json',
            import.meta.url,
          ),
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

  it('历史 migration checksum 被改写时拒绝启动', () => {
    const storage = createCodingStorage();
    storage.db.$client
      .prepare('update __drizzle_migrations set hash = ?')
      .run('tampered');
    storage.close();

    expect(() => createCodingStorage()).toThrow('migration checksum mismatch');
  });

  it('数据库包含未来 migration 时拒绝由旧 Server 打开', () => {
    const storage = createCodingStorage();
    storage.close();
    const database = new Database(stateDatabasePath());
    database
      .prepare(
        'insert into __drizzle_migrations (hash, created_at) values (?, ?)',
      )
      .run('future', Date.now() + 1_000_000);
    database.close();

    expect(() => createCodingStorage()).toThrow('migration version is newer');
  });

  it('从旧版 state.sqlite 幂等迁移 repo、workspace 及关联关系', () => {
    const legacyPath = legacyStateDatabasePath();
    mkdirSync(home, { recursive: true });
    const legacy = new Database(legacyPath);
    legacy.exec(`
      create table repositories (
        id text primary key,
        key text not null,
        remote_url text,
        mirror_path text not null,
        default_branch text not null,
        created_at text not null,
        updated_at text not null
      );
      create table workspaces (
        id text primary key,
        kind text not null,
        name text not null,
        root_path text not null,
        status text not null,
        branch text,
        tmux_session text,
        last_synced_at text,
        created_at text not null,
        updated_at text not null
      );
      create table workspace_repositories (
        workspace_id text not null,
        repository_id text not null,
        checkout_path text not null,
        checkout_role text,
        checkout_mode text,
        branch text,
        head_commit text,
        status text not null,
        last_git_status text,
        last_synced_at text,
        created_at text not null,
        updated_at text not null,
        primary key (workspace_id, repository_id)
      );
    `);
    legacy
      .prepare(
        `insert into repositories
         (id, key, remote_url, mirror_path, default_branch, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'repo-legacy',
        'org/project',
        'https://example.test/project.git',
        '/home/alice/.ello/mirrors/org/project.git',
        'main',
        '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z',
      );
    legacy
      .prepare(
        `insert into workspaces
         (id, kind, name, root_path, status, branch, tmux_session,
          last_synced_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'workspace-legacy',
        'feature',
        'legacy-workspace',
        '/home/alice/workspaces/legacy',
        'active',
        'feature/legacy',
        null,
        null,
        '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z',
      );
    legacy
      .prepare(
        `insert into workspace_repositories
         (workspace_id, repository_id, checkout_path, checkout_role,
          checkout_mode, branch, head_commit, status, last_git_status,
          last_synced_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'workspace-legacy',
        'repo-legacy',
        '/home/alice/workspaces/legacy/project',
        null,
        null,
        'feature/legacy',
        'abc123',
        'active',
        null,
        null,
        '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z',
      );
    legacy.close();

    const first = createCodingStorage();
    expect(first.repositories.list()).toHaveLength(1);
    expect(first.workspaces.list()).toEqual([
      expect.objectContaining({
        id: 'workspace-legacy',
        name: 'legacy-workspace',
        repos: [
          expect.objectContaining({
            repositoryId: 'repo-legacy',
            checkoutMode: 'branch',
            role: 'development',
          }),
        ],
      }),
    ]);
    first.close();

    const second = createCodingStorage();
    expect(second.repositories.list()).toHaveLength(1);
    expect(second.workspaces.list()).toHaveLength(1);
    second.close();
  });
});
