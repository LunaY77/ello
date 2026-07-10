import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runCodingStorageMigrations } from '../storage/migration-runner.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('coding storage migration runner', () => {
  it('按顺序执行且重启不重复执行', async () => {
    const dir = await migrationDir({
      '0001-initial.sql': 'create table state(id text primary key);',
      '0002-extra.sql': 'alter table state add column value text;',
    });
    const db = new Database(':memory:');

    runCodingStorageMigrations(db, { migrationsDir: dir });
    runCodingStorageMigrations(db, { migrationsDir: dir });

    expect(
      db
        .prepare('select version, name from schema_migrations order by version')
        .all(),
    ).toEqual([
      { version: 1, name: 'initial' },
      { version: 2, name: 'extra' },
    ]);
    db.close();
  });

  it('已执行 migration 内容漂移直接失败', async () => {
    const dir = await migrationDir({
      '0001-initial.sql': 'create table state(id text primary key);',
    });
    const db = new Database(':memory:');
    runCodingStorageMigrations(db, { migrationsDir: dir });
    await writeFile(
      path.join(dir, '0001-initial.sql'),
      'create table state(id integer primary key);',
      'utf8',
    );

    expect(() =>
      runCodingStorageMigrations(db, { migrationsDir: dir }),
    ).toThrow('checksum or name does not match');
    db.close();
  });

  it('单个 migration 失败时整体回滚', async () => {
    const dir = await migrationDir({
      '0001-initial.sql': 'create table state(id text primary key);',
      '0002-broken.sql': [
        'create table partial_state(id text primary key);',
        'this is invalid sql;',
      ].join('\n'),
    });
    const db = new Database(':memory:');

    expect(() =>
      runCodingStorageMigrations(db, { migrationsDir: dir }),
    ).toThrow();
    expect(
      db
        .prepare(
          "select name from sqlite_master where type = 'table' and name = 'partial_state'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare('select version from schema_migrations order by version')
        .all(),
    ).toEqual([{ version: 1 }]);
    db.close();
  });

  it('数据库版本高于当前二进制时直接失败', async () => {
    const dir = await migrationDir({
      '0001-initial.sql': 'create table state(id text primary key);',
    });
    const db = new Database(':memory:');
    runCodingStorageMigrations(db, { migrationsDir: dir });
    db.prepare(
      `insert into schema_migrations(version, name, checksum, applied_at)
       values (2, 'future', 'future', 'now')`,
    ).run();

    expect(() =>
      runCodingStorageMigrations(db, { migrationsDir: dir }),
    ).toThrow('newer than this binary supports');
    db.close();
  });

  it('识别并登记已存在的初始 schema', async () => {
    const sql = 'create table state(id text primary key);';
    const dir = await migrationDir({ '0001-initial.sql': sql });
    const db = new Database(':memory:');
    db.exec(sql);

    runCodingStorageMigrations(db, { migrationsDir: dir });

    expect(
      db.prepare('select version, name from schema_migrations').get(),
    ).toEqual({ version: 1, name: 'initial' });
    db.close();
  });
});

async function migrationDir(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ello-migrations-'));
  dirs.push(dir);
  await Promise.all(
    Object.entries(files).map(([name, sql]) =>
      writeFile(path.join(dir, name), sql, 'utf8'),
    ),
  );
  return dir;
}
