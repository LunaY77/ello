/**
 * 本文件负责 workspace feature 的持久化操作与一致性。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import {
  transaction,
  type CodingDatabase,
} from '../../infra/database/database.js';
import {
  repositories,
  workspaceRepositories,
  workspaceSyncRuns,
  workspaces,
} from '../../infra/database/schema.js';

import type {
  CheckoutMode,
  Workspace,
  WorkspaceKind,
  WorkspaceRepo,
  WorkspaceRepoRole,
  WorkspaceStatus,
} from './types.js';

export interface WorkspaceObservation {
  readonly workspace: Workspace;
  readonly missingRoot: boolean;
  readonly repos: readonly {
    readonly repositoryId: string;
    readonly key: string;
    readonly path: string;
    readonly status: 'active' | 'missing' | 'dirty' | 'invalid' | 'removed';
    readonly gitStatus?: string;
    readonly error?: string;
  }[];
}

export interface WorkspaceReconcileResult {
  readonly id: string;
  readonly status: 'completed';
  readonly checkedCount: number;
  readonly fixedCount: number;
  readonly observations: readonly WorkspaceObservation[];
}

/** workspace 与 checkout 关系的结构化持久化边界。 */
export interface WorkspaceRecordStore {
  /**
   * 按 Workspace 持久化 store 模块 的一致性约束执行 `insert` 状态变更。
   *
   * Args:
   * - `workspace`: `insert` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `insert` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  insert(workspace: Workspace): Workspace;
  /**
   * 按 Workspace 持久化 store 模块 的一致性约束执行 `update` 状态变更。
   *
   * Args:
   * - `workspace`: `update` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `update` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 Workspace 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  update(workspace: Workspace): Workspace;
  /**
   * 读取 Workspace 持久化 store 模块 的 `list` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `filters`: `list` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  list(filters?: {
    readonly kind?: WorkspaceKind;
    readonly status?: WorkspaceStatus;
  }): ReadonlyArray<Workspace>;
  /**
   * 读取 Workspace 持久化 store 模块 的 `find` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `kind`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
   * - `name`: `find` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  find(kind: WorkspaceKind, name: string): Workspace | null;
  /**
   * 读取 Workspace 持久化 store 模块 的 `findActive` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `kind`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
   * - `name`: `findActive` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  findActive(kind: WorkspaceKind, name: string): Workspace | null;
  /**
   * 读取 Workspace 持久化 store 模块 的 `listArchived` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `kind`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
   * - `name`: `listArchived` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  listArchived(kind?: WorkspaceKind, name?: string): ReadonlyArray<Workspace>;
  /**
   * 读取 Workspace 持久化 store 模块 的 `findById` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `id`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  findById(id: string): Workspace | null;
  /**
   * 读取 Workspace 持久化 store 模块 的 `findActiveByRoot` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `rootPath`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  findActiveByRoot(rootPath: string): Workspace | null;
  /**
   * 按 Workspace 持久化 store 模块 的一致性约束执行 `recordReconcile` 状态变更。
   *
   * Args:
   * - `observations`: `recordReconcile` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `recordReconcile` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  recordReconcile(
    observations: ReadonlyArray<WorkspaceObservation>,
  ): WorkspaceReconcileResult;
}

/**
 * 创建仅闭包持有数据库连接的 Workspace record store。
 *
 * Args:
 * - `db`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
 *
 * Returns:
 * - 返回 `createWorkspaceRecordStore` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Workspace 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createWorkspaceRecordStore(
  db: CodingDatabase,
): WorkspaceRecordStore {
  function insert(workspace: Workspace): Workspace {
    transaction(db, () => {
      db.insert(workspaces).values(workspaceRow(workspace)).run();
      replaceRepos(workspace);
    });
    return workspace;
  }

  function update(workspace: Workspace): Workspace {
    transaction(db, () => {
      const result = db
        .update(workspaces)
        .set({
          kind: workspace.kind,
          name: workspace.name,
          rootPath: workspace.rootPath,
          status: workspace.status,
          branch: workspace.branch,
          tmuxSession: workspace.tmuxSession,
          updatedAt: workspace.updatedAt,
        })
        .where(eq(workspaces.id, workspace.id))
        .run();
      if (result.changes !== 1) {
        throw new Error(`Unknown workspace id: ${workspace.id}`);
      }
      replaceRepos(workspace);
    });
    return workspace;
  }

  function list(
    filters: {
      readonly kind?: WorkspaceKind;
      readonly status?: WorkspaceStatus;
    } = {},
  ): readonly Workspace[] {
    const clauses = [
      ...(filters.kind === undefined
        ? []
        : [eq(workspaces.kind, filters.kind)]),
      ...(filters.status === undefined
        ? [eq(workspaces.status, 'active')]
        : [eq(workspaces.status, filters.status)]),
    ];
    return db
      .select()
      .from(workspaces)
      .where(clauses.length === 1 ? clauses[0] : and(...clauses))
      .orderBy(asc(workspaces.rootPath))
      .all()
      .map((row) => toWorkspace(row));
  }

  function find(kind: WorkspaceKind, name: string): Workspace | null {
    const active = findActive(kind, name);
    if (active !== null) return active;
    const archived = listArchived(kind, name);
    if (archived.length === 0) return null;
    if (archived.length > 1) {
      throw new Error(
        `Workspace selector is ambiguous: ${kind}/${name}; use workspace id`,
      );
    }
    const [workspace] = archived;
    if (workspace === undefined) {
      throw new Error(`Archived workspace lookup failed: ${kind}/${name}`);
    }
    return workspace;
  }

  function findActive(kind: WorkspaceKind, name: string): Workspace | null {
    const row = db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.kind, kind),
          eq(workspaces.name, name),
          inArray(workspaces.status, ['active', 'missing']),
        ),
      )
      .get();
    return row === undefined ? null : toWorkspace(row);
  }

  function listArchived(
    kind?: WorkspaceKind,
    name?: string,
  ): readonly Workspace[] {
    const clauses = [
      eq(workspaces.status, 'archived'),
      ...(kind === undefined ? [] : [eq(workspaces.kind, kind)]),
      ...(name === undefined ? [] : [eq(workspaces.name, name)]),
    ];
    return db
      .select()
      .from(workspaces)
      .where(and(...clauses))
      .orderBy(desc(workspaces.updatedAt))
      .all()
      .map((row) => toWorkspace(row));
  }

  function findById(id: string): Workspace | null {
    const row = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    return row === undefined ? null : toWorkspace(row);
  }

  function findActiveByRoot(rootPath: string): Workspace | null {
    const row = db
      .select()
      .from(workspaces)
      .where(
        and(eq(workspaces.rootPath, rootPath), eq(workspaces.status, 'active')),
      )
      .get();
    return row === undefined ? null : toWorkspace(row);
  }

  function recordReconcile(
    observations: readonly WorkspaceObservation[],
  ): WorkspaceReconcileResult {
    const id = randomUUID();
    const now = new Date().toISOString();
    transaction(db, () => {
      db.insert(workspaceSyncRuns)
        .values({
          id,
          workspaceId: null,
          status: 'completed',
          checkedCount: observations.reduce(
            (sum, item) => sum + item.repos.length,
            0,
          ),
          fixedCount: 0,
          errorMessage: null,
          startedAt: now,
          completedAt: new Date().toISOString(),
        })
        .run();
    });
    return {
      id,
      status: 'completed',
      checkedCount: observations.reduce(
        (sum, item) => sum + item.repos.length,
        0,
      ),
      fixedCount: 0,
      observations,
    };
  }

  function replaceRepos(workspace: Workspace): void {
    db.delete(workspaceRepositories)
      .where(eq(workspaceRepositories.workspaceId, workspace.id))
      .run();
    for (const repo of workspace.repos) {
      db.insert(workspaceRepositories)
        .values({
          workspaceId: workspace.id,
          repositoryId: repo.repositoryId,
          checkoutPath: repo.path,
          checkoutRole: repo.role,
          checkoutMode: repo.checkoutMode,
          branch: repo.branch,
          headCommit: repo.headCommit,
          status: workspace.status === 'deleted' ? 'removed' : 'active',
          lastGitStatus: null,
          lastSyncedAt: null,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        })
        .run();
    }
  }

  function toWorkspace(row: typeof workspaces.$inferSelect): Workspace {
    const repoRows = db
      .select({
        repositoryId: repositories.id,
        key: repositories.key,
        path: workspaceRepositories.checkoutPath,
        role: workspaceRepositories.checkoutRole,
        checkoutMode: workspaceRepositories.checkoutMode,
        branch: workspaceRepositories.branch,
        headCommit: workspaceRepositories.headCommit,
      })
      .from(workspaceRepositories)
      .innerJoin(
        repositories,
        eq(workspaceRepositories.repositoryId, repositories.id),
      )
      .where(eq(workspaceRepositories.workspaceId, row.id))
      .orderBy(asc(repositories.key))
      .all();
    const repos: WorkspaceRepo[] = repoRows.map((repo) => ({
      repositoryId: repo.repositoryId,
      key: repo.key,
      path: repo.path,
      role: parseWorkspaceRepoRole(row.id, repo.role),
      checkoutMode: parseCheckoutMode(row.id, repo.checkoutMode),
      branch: repo.branch,
      headCommit: repo.headCommit,
    }));
    return {
      id: row.id,
      kind: parseWorkspaceKind(row.id, row.kind),
      name: row.name,
      rootPath: row.rootPath,
      status: parseWorkspaceStatus(row.id, row.status),
      branch: row.branch,
      tmuxSession: row.tmuxSession,
      repos,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  return {
    insert,
    update,
    list,
    find,
    findActive,
    listArchived,
    findById,
    findActiveByRoot,
    recordReconcile,
  };
}

function parseWorkspaceKind(rowId: string, value: string): WorkspaceKind {
  switch (value) {
    case 'feature':
    case 'fix':
    case 'refactor':
    case 'explore':
      return value;
    default:
      throw new Error(
        `Invalid workspaces row ${rowId}: unknown kind ${value}.`,
      );
  }
}

function parseWorkspaceStatus(rowId: string, value: string): WorkspaceStatus {
  switch (value) {
    case 'active':
    case 'archived':
    case 'missing':
    case 'deleted':
      return value;
    default:
      throw new Error(
        `Invalid workspaces row ${rowId}: unknown status ${value}.`,
      );
  }
}

function parseWorkspaceRepoRole(
  rowId: string,
  value: string,
): WorkspaceRepoRole {
  switch (value) {
    case 'development':
    case 'reference':
      return value;
    default:
      throw new Error(
        `Invalid workspace_repositories row for ${rowId}: unknown role ${value}.`,
      );
  }
}

function parseCheckoutMode(rowId: string, value: string): CheckoutMode {
  switch (value) {
    case 'branch':
    case 'detached':
      return value;
    default:
      throw new Error(
        `Invalid workspace_repositories row for ${rowId}: unknown checkout mode ${value}.`,
      );
  }
}

function workspaceRow(workspace: Workspace): typeof workspaces.$inferInsert {
  return {
    id: workspace.id,
    kind: workspace.kind,
    name: workspace.name,
    rootPath: workspace.rootPath,
    status: workspace.status,
    branch: workspace.branch,
    tmuxSession: workspace.tmuxSession,
    lastSyncedAt: null,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}
