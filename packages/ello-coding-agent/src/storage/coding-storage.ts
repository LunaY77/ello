import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { ArtifactStore } from './artifact-store.js';
import {
  configureCodingDatabase,
  createCodingDatabase,
  type CodingDatabase,
} from './database.js';
import { runCodingStorageMigrations } from './migration-runner.js';
import { globalArtifactsDir, globalStateDatabasePath } from './paths.js';
import { CheckpointRepository } from './repositories/checkpoint-repository.js';
import { RepositoryRepository } from './repositories/repository-repository.js';
import { TaskBoardRepository } from './repositories/task-board-repository.js';
import { UsageRepository } from './repositories/usage-repository.js';
import { WorkspaceRepository } from './repositories/workspace-repository.js';

export interface CodingStorage {
  readonly db: CodingDatabase;
  readonly artifacts: ArtifactStore;
  readonly taskBoards: TaskBoardRepository;
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
  const artifactStore = new ArtifactStore(
    db,
    options.artifactsDir ?? globalArtifactsDir(),
  );
  let closed = false;
  return {
    db,
    artifacts: artifactStore,
    taskBoards: new TaskBoardRepository(db),
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
