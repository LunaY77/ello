import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export function runCodingStorageMigrations(
  client: Database.Database,
  options: { readonly migrationsDir?: string } = {},
): void {
  const migrations = loadMigrations(
    options.migrationsDir ?? defaultMigrationsDir(),
  );
  const hadApplicationSchema = applicationSchema(client).length > 0;
  client.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      checksum text not null,
      applied_at text not null
    )
  `);

  let applied = readAppliedMigrations(client);
  if (applied.length === 0 && hadApplicationSchema) {
    adoptInitialSchema(client, migrations[0]!);
    applied = readAppliedMigrations(client);
  }
  validateAppliedMigrations(applied, migrations);

  for (const migration of migrations.slice(applied.length)) {
    const apply = client.transaction(() => {
      client.exec(migration.sql);
      client
        .prepare(
          `insert into schema_migrations(version, name, checksum, applied_at)
           values (?, ?, ?, ?)`,
        )
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          new Date().toISOString(),
        );
    });
    apply();
  }
}

function loadMigrations(dir: string): readonly Migration[] {
  const files = readdirSync(dir)
    .filter((file) => /^\d{4}-[a-z0-9-]+\.sql$/u.test(file))
    .sort();
  if (files.length === 0) {
    throw new Error(`No coding storage migrations found in ${dir}.`);
  }
  return files.map((file, index) => {
    const version = Number(file.slice(0, 4));
    const expectedVersion = index + 1;
    if (version !== expectedVersion) {
      throw new Error(
        `Coding storage migrations must be continuous: expected ${String(expectedVersion).padStart(4, '0')}, found ${file}.`,
      );
    }
    const sql = readFileSync(path.join(dir, file), 'utf8');
    return {
      version,
      name: file.slice(5, -4),
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    };
  });
}

function readAppliedMigrations(
  client: Database.Database,
): readonly AppliedMigration[] {
  return client
    .prepare(
      'select version, name, checksum from schema_migrations order by version',
    )
    .all() as AppliedMigration[];
}

function validateAppliedMigrations(
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[],
): void {
  for (let index = 0; index < applied.length; index += 1) {
    const row = applied[index]!;
    const expectedVersion = index + 1;
    if (row.version !== expectedVersion) {
      throw new Error(
        `Coding storage migration ledger has a gap at version ${expectedVersion}.`,
      );
    }
    const migration = migrations[index];
    if (migration === undefined) {
      throw new Error(
        `Coding storage schema version ${row.version} is newer than this binary supports.`,
      );
    }
    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      throw new Error(
        `Coding storage migration ${row.version} checksum or name does not match ${migration.name}.`,
      );
    }
  }
}

function adoptInitialSchema(
  client: Database.Database,
  initialMigration: Migration,
): void {
  const expected = new Database(':memory:');
  try {
    expected.exec(initialMigration.sql);
    if (
      JSON.stringify(applicationSchema(client)) !==
      JSON.stringify(applicationSchema(expected))
    ) {
      throw new Error(
        'Unversioned coding storage schema does not match migration 0001. Back up and rebuild state.sqlite.',
      );
    }
  } finally {
    expected.close();
  }
  client
    .prepare(
      `insert into schema_migrations(version, name, checksum, applied_at)
       values (?, ?, ?, ?)`,
    )
    .run(
      initialMigration.version,
      initialMigration.name,
      initialMigration.checksum,
      new Date().toISOString(),
    );
}

function applicationSchema(client: Database.Database): readonly string[] {
  const rows = client
    .prepare(
      `select type, name, tbl_name as tableName, sql
       from sqlite_master
       where sql is not null
         and name not like 'sqlite_%'
         and name <> 'schema_migrations'
       order by type, name`,
    )
    .all() as Array<{
    readonly type: string;
    readonly name: string;
    readonly tableName: string;
    readonly sql: string;
  }>;
  return rows.map((row) =>
    [row.type, row.name, row.tableName, normalizeSql(row.sql)].join('|'),
  );
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function defaultMigrationsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
}
