import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { SqliteTaskStore } from '../tasks/sqlite-store.js';

import {
  configureCodingDatabase,
  createCodingDatabase,
  type CodingDatabase,
} from './database.js';
import { runCodingStorageMigrations } from './migration-runner.js';
import { globalStateDatabasePath } from './paths.js';
import { CheckpointRepository } from './repositories/checkpoint-repository.js';
import { MemoryRepository } from './repositories/memory-repository.js';
import { UsageRepository } from './repositories/usage-repository.js';
import { WorkspaceRepository } from './repositories/workspace-repository.js';

export interface CodingStorage {
  readonly db: CodingDatabase;
  readonly tasks: SqliteTaskStore;
  readonly checkpoints: CheckpointRepository;
  readonly workspaces: WorkspaceRepository;
  readonly usage: UsageRepository;
  readonly memory: MemoryRepository;
  close(): void;
}

export function createCodingStorage(
  options: { readonly databasePath?: string } = {},
): CodingStorage {
  const databasePath = options.databasePath ?? globalStateDatabasePath();
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const client = new Database(databasePath);
  try {
    configureCodingDatabase(client);
    runCodingStorageMigrations(client);
  } catch (error) {
    client.close();
    throw error;
  }
  const db = createCodingDatabase(client);
  let closed = false;
  return {
    db,
    tasks: new SqliteTaskStore(db, 'default'),
    checkpoints: new CheckpointRepository(db),
    workspaces: new WorkspaceRepository(db),
    usage: new UsageRepository(db),
    memory: new MemoryRepository(db),
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      client.close();
    },
  };
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
