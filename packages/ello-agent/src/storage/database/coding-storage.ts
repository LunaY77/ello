import { mkdirSync } from 'node:fs';
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
    migrate(db, { migrationsFolder });
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
