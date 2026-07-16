import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import type {
  Workspace,
  WorkspaceKind,
  WorkspaceRepo,
  WorkspaceStatus,
} from '../../workspace/types.js';
import { transaction, type CodingDatabase } from '../database.js';
import {
  repositories,
  workspaceRepositories,
  workspaceSyncRuns,
  workspaces,
} from '../schema.js';

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

/** workspace 与 checkout 关系的唯一结构化主源。 */
export class WorkspaceRepository {
  constructor(private readonly db: CodingDatabase) {}

  insert(workspace: Workspace): Workspace {
    transaction(this.db, () => {
      this.db.insert(workspaces).values(workspaceRow(workspace)).run();
      this.replaceRepos(workspace);
    });
    return workspace;
  }

  update(workspace: Workspace): Workspace {
    transaction(this.db, () => {
      const result = this.db
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
      this.replaceRepos(workspace);
    });
    return workspace;
  }

  list(
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
    return this.db
      .select()
      .from(workspaces)
      .where(clauses.length === 1 ? clauses[0] : and(...clauses))
      .orderBy(asc(workspaces.rootPath))
      .all()
      .map((row) => this.toWorkspace(row));
  }

  find(kind: WorkspaceKind, name: string): Workspace | null {
    const active = this.findActive(kind, name);
    if (active !== null) return active;
    const archived = this.listArchived(kind, name);
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

  findActive(kind: WorkspaceKind, name: string): Workspace | null {
    const row = this.db
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
    return row === undefined ? null : this.toWorkspace(row);
  }

  listArchived(kind?: WorkspaceKind, name?: string): readonly Workspace[] {
    const clauses = [
      eq(workspaces.status, 'archived'),
      ...(kind === undefined ? [] : [eq(workspaces.kind, kind)]),
      ...(name === undefined ? [] : [eq(workspaces.name, name)]),
    ];
    return this.db
      .select()
      .from(workspaces)
      .where(and(...clauses))
      .orderBy(desc(workspaces.updatedAt))
      .all()
      .map((row) => this.toWorkspace(row));
  }

  findById(id: string): Workspace | null {
    const row = this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .get();
    return row === undefined ? null : this.toWorkspace(row);
  }

  findActiveByRoot(rootPath: string): Workspace | null {
    const row = this.db
      .select()
      .from(workspaces)
      .where(
        and(eq(workspaces.rootPath, rootPath), eq(workspaces.status, 'active')),
      )
      .get();
    return row === undefined ? null : this.toWorkspace(row);
  }

  recordReconcile(
    observations: readonly WorkspaceObservation[],
  ): WorkspaceReconcileResult {
    const id = randomUUID();
    const now = new Date().toISOString();
    transaction(this.db, () => {
      this.db
        .insert(workspaceSyncRuns)
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

  private replaceRepos(workspace: Workspace): void {
    this.db
      .delete(workspaceRepositories)
      .where(eq(workspaceRepositories.workspaceId, workspace.id))
      .run();
    for (const repo of workspace.repos) {
      this.db
        .insert(workspaceRepositories)
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

  private toWorkspace(row: typeof workspaces.$inferSelect): Workspace {
    const repoRows = this.db
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
      role: repo.role as WorkspaceRepo['role'],
      checkoutMode: repo.checkoutMode as WorkspaceRepo['checkoutMode'],
      branch: repo.branch,
      headCommit: repo.headCommit,
    }));
    return {
      id: row.id,
      kind: row.kind as WorkspaceKind,
      name: row.name,
      rootPath: row.rootPath,
      status: row.status as WorkspaceStatus,
      branch: row.branch,
      tmuxSession: row.tmuxSession,
      repos,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
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
