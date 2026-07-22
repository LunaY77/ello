/**
 * 本文件负责 Workspace 领域内 Repository registry 的持久化操作与一致性。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { CodingDatabase } from '../../infra/database/database.js';
import { transaction } from '../../infra/database/database.js';
import {
  repositories,
  workspaceRepositories,
  workspaces,
} from '../../infra/database/schema.js';

import type { Repository } from './repository.js';

/** repository registry 对外暴露的同步持久化操作。 */
export interface RepositoryStore {
  /**
   * 按 Repository 持久化 store 模块 的一致性约束执行 `insert` 状态变更。
   *
   * Args:
   * - `repository`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
   *
   * Returns:
   * - 返回 `insert` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  insert(repository: Repository): Repository;
  /**
   * 读取 Repository 持久化 store 模块 的 `list` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  list(): ReadonlyArray<Repository>;
  /**
   * 读取 Repository 持久化 store 模块 的 `find` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `key`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  find(key: string): Repository | null;
  /**
   * 按 Repository 持久化 store 模块 的一致性约束执行 `update` 状态变更。
   *
   * Args:
   * - `repository`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
   *
   * Returns:
   * - 返回 `update` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 Repository 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  update(repository: Repository): Repository;
  /**
   * 按 Repository 持久化 store 模块 的一致性约束执行 `remove` 状态变更。
   *
   * Args:
   * - `repository`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
   *
   * Returns:
   * - Repository 持久化 store 模块 的同步状态变更完成后返回，不产生业务结果。
   *
   * Throws:
   * - 当 Repository 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  remove(repository: Repository): void;
}

/**
 * 创建只闭包持有数据库连接的 Repository store。
 *
 * Args:
 * - `db`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
 *
 * Returns:
 * - 返回 `createRepositoryStore` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Repository 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createRepositoryStore(db: CodingDatabase): RepositoryStore {
  return { insert, list, find, update, remove };

  function insert(repository: Repository): Repository {
    db.insert(repositories).values(toRow(repository)).run();
    return repository;
  }

  function list(): ReadonlyArray<Repository> {
    return db
      .select()
      .from(repositories)
      .orderBy(asc(repositories.key))
      .all()
      .map(fromRow);
  }

  function find(key: string): Repository | null {
    const row = db
      .select()
      .from(repositories)
      .where(eq(repositories.key, key))
      .get();
    return row === undefined ? null : fromRow(row);
  }

  function update(repository: Repository): Repository {
    const result = db
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

  function remove(repository: Repository): void {
    const references = db
      .select({ workspace: workspaces.id })
      .from(workspaceRepositories)
      .innerJoin(
        workspaces,
        eq(workspaceRepositories.workspaceId, workspaces.id),
      )
      .where(eq(workspaceRepositories.repositoryId, repository.id))
      .all();
    const retainedReference = db
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
    transaction(db, () => {
      for (const reference of references) {
        db.delete(workspaceRepositories)
          .where(
            and(
              eq(workspaceRepositories.workspaceId, reference.workspace),
              eq(workspaceRepositories.repositoryId, repository.id),
            ),
          )
          .run();
      }
      db.delete(repositories).where(eq(repositories.id, repository.id)).run();
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
