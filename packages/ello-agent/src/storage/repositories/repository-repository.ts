import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Repository } from '../../workspace/types.js';
import type { CodingDatabase } from '../database/database.js';
import { transaction } from '../database/database.js';
import {
  repositories,
  workspaceRepositories,
  workspaces,
} from '../database/schema.js';

/** repository registry 的唯一结构化主源。 */
export class RepositoryRepository {
  constructor(private readonly db: CodingDatabase) {}

  insert(repository: Repository): Repository {
    this.db.insert(repositories).values(toRow(repository)).run();
    return repository;
  }

  list(): readonly Repository[] {
    return this.db
      .select()
      .from(repositories)
      .orderBy(asc(repositories.key))
      .all()
      .map(fromRow);
  }

  find(key: string): Repository | null {
    const row = this.db
      .select()
      .from(repositories)
      .where(eq(repositories.key, key))
      .get();
    return row === undefined ? null : fromRow(row);
  }

  update(repository: Repository): Repository {
    const result = this.db
      .update(repositories)
      .set({
        key: repository.key,
        remoteUrl: repository.remoteUrl,
        defaultBranch: repository.defaultBranch,
        updatedAt: repository.updatedAt,
      })
      .where(eq(repositories.id, repository.id))
      .run();
    if (result.changes !== 1) {
      throw new Error(`Unknown repository id: ${repository.id}`);
    }
    return repository;
  }

  remove(repository: Repository): void {
    const references = this.db
      .select({ workspace: workspaces.id })
      .from(workspaceRepositories)
      .innerJoin(
        workspaces,
        eq(workspaceRepositories.workspaceId, workspaces.id),
      )
      .where(eq(workspaceRepositories.repositoryId, repository.id))
      .all();
    const retainedReference = this.db
      .select({ workspace: workspaces.id })
      .from(workspaceRepositories)
      .innerJoin(
        workspaces,
        eq(workspaceRepositories.workspaceId, workspaces.id),
      )
      .where(
        and(
          eq(workspaceRepositories.repositoryId, repository.id),
          eq(workspaceRepositories.status, 'active'),
          inArray(workspaces.status, ['active', 'archived', 'missing']),
        ),
      )
      .get();
    if (retainedReference !== undefined) {
      throw new Error(
        `Repository is referenced by workspace: ${retainedReference.workspace}`,
      );
    }
    transaction(this.db, () => {
      for (const reference of references) {
        this.db
          .delete(workspaceRepositories)
          .where(
            and(
              eq(workspaceRepositories.workspaceId, reference.workspace),
              eq(workspaceRepositories.repositoryId, repository.id),
            ),
          )
          .run();
      }
      this.db
        .delete(repositories)
        .where(eq(repositories.id, repository.id))
        .run();
    });
  }
}

function toRow(repository: Repository): typeof repositories.$inferInsert {
  return {
    id: repository.id,
    key: repository.key,
    remoteUrl: repository.remoteUrl,
    mirrorPath: repository.mirrorPath,
    defaultBranch: repository.defaultBranch,
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
  };
}

function fromRow(row: typeof repositories.$inferSelect): Repository {
  return {
    id: row.id,
    key: row.key,
    mirrorPath: requiredRepositoryField(row.mirrorPath, row.id, 'mirror_path'),
    remoteUrl: row.remoteUrl,
    defaultBranch: requiredRepositoryField(
      row.defaultBranch,
      row.id,
      'default_branch',
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requiredRepositoryField(
  value: string | null,
  repositoryId: string,
  field: string,
): string {
  if (value === null) {
    throw new Error(`Repository ${repositoryId} has no ${field}.`);
  }
  return value;
}
