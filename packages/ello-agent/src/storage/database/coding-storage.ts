import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { ArtifactStore } from '../artifacts/artifact-store.js';
import { artifactsDir, stateDatabasePath } from '../paths.js';
import { CheckpointRepository } from '../repositories/checkpoint-repository.js';
import { RepositoryRepository } from '../repositories/repository-repository.js';
import { TaskBoardRepository } from '../repositories/task-board-repository.js';
import { ThreadCatalogRepository } from '../repositories/thread-catalog-repository.js';
import { UsageRepository } from '../repositories/usage-repository.js';
import { WorkspaceRepository } from '../repositories/workspace-repository.js';

import {
  configureCodingDatabase,
  createCodingDatabase,
  type CodingDatabase,
} from './database.js';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

interface MigrationDescriptor {
  readonly hash: string;
  readonly createdAt: number;
  readonly tag: string;
}

export interface CodingStorage {
  readonly db: CodingDatabase;
  readonly artifacts: ArtifactStore;
  readonly taskBoards: TaskBoardRepository;
  readonly threads: ThreadCatalogRepository;
  readonly checkpoints: CheckpointRepository;
  readonly repositories: RepositoryRepository;
  readonly workspaces: WorkspaceRepository;
  readonly usage: UsageRepository;
  close(): void;
}

export function createCodingStorage(
  options: {
    readonly databasePath?: string;
    readonly artifactsDir?: string;
  } = {},
): CodingStorage {
  const databasePath = options.databasePath ?? stateDatabasePath();
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const client = new Database(databasePath);
  try {
    configureCodingDatabase(client);
    const db = createCodingDatabase(client);
    validateAppliedMigrations(client, readMigrationDescriptors());
    migrate(db, { migrationsFolder });
    validateAppliedMigrations(client, readMigrationDescriptors());
    const artifactStore = new ArtifactStore(
      db,
      options.artifactsDir ?? artifactsDir(),
    );
    let closed = false;
    return {
      db,
      artifacts: artifactStore,
      taskBoards: new TaskBoardRepository(db),
      threads: new ThreadCatalogRepository(db),
      checkpoints: new CheckpointRepository(db, artifactStore),
      repositories: new RepositoryRepository(db),
      workspaces: new WorkspaceRepository(db),
      usage: new UsageRepository(db),
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        client.close();
      },
    };
  } catch (error) {
    client.close();
    throw error;
  }
}

/**
 * Drizzle 默认只按时间戳寻找下一条迁移，不会复核已经执行过的 SQL 内容。
 * 启动前后都校验完整前缀，避免历史迁移被改写或较新数据库被旧程序继续写入。
 */
function validateAppliedMigrations(
  client: Database.Database,
  expected: readonly MigrationDescriptor[],
): void {
  const table = client
    .prepare(
      "select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  if (table === undefined) return;
  const applied = client
    .prepare(
      'select hash, created_at as createdAt from __drizzle_migrations order by created_at, id',
    )
    .all() as readonly { readonly hash: string; readonly createdAt: number }[];
  if (applied.length > expected.length) {
    throw new Error(
      `Database migration version is newer than this Server (${applied.length} > ${expected.length}).`,
    );
  }
  for (const [index, actual] of applied.entries()) {
    const migration = expected[index];
    if (migration === undefined || actual.createdAt !== migration.createdAt) {
      throw new Error(
        `Database migration history diverges at position ${index + 1}; refusing to continue.`,
      );
    }
    if (actual.hash !== migration.hash) {
      throw new Error(
        `Database migration checksum mismatch for ${migration.tag}; refusing to continue.`,
      );
    }
  }
}

function readMigrationDescriptors(): readonly MigrationDescriptor[] {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as {
    readonly entries?: readonly {
      readonly when?: unknown;
      readonly tag?: unknown;
    }[];
  };
  if (!Array.isArray(journal.entries)) {
    throw new Error('Migration journal has no entries.');
  }
  return journal.entries.map((entry, index) => {
    if (
      typeof entry.when !== 'number' ||
      !Number.isSafeInteger(entry.when) ||
      typeof entry.tag !== 'string' ||
      entry.tag === ''
    ) {
      throw new Error(`Migration journal entry ${index + 1} is invalid.`);
    }
    const sql = readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`));
    return {
      tag: entry.tag,
      createdAt: entry.when,
      hash: createHash('sha256').update(sql).digest('hex'),
    };
  });
}

export async function withCodingStorage<T>(
  fn: (storage: CodingStorage) => T | Promise<T>,
): Promise<T> {
  const storage = createCodingStorage();
  try {
    return await fn(storage);
  } finally {
    storage.close();
  }
}
