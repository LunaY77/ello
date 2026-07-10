import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import type {
  RepoEntry,
  WorkspaceKind,
  WorkspaceManifest,
  WorkspaceRepo,
} from '../../workspace/types.js';
import { transaction, type CodingDatabase } from '../database.js';
import {
  repositories,
  workspaceRepositories,
  workspaceSyncRuns,
  workspaces,
} from '../schema.js';

export interface WorkspaceSyncDiff {
  readonly workspace: WorkspaceManifest;
  readonly missingRoot: boolean;
  readonly repos: readonly {
    readonly key: string;
    readonly path: string;
    readonly status: 'active' | 'missing' | 'dirty' | 'removed';
    readonly gitStatus?: string | undefined;
  }[];
}

export interface WorkspaceSyncResult {
  readonly id: string;
  readonly status: 'completed' | 'failed';
  readonly checkedCount: number;
  readonly fixedCount: number;
  readonly diffs: readonly WorkspaceSyncDiff[];
}

/**
 * workspace 仓储。
 *
 * DB 是 workspace 的唯一事实源，所有 mutation 在当前连接内同步提交。
 */
export class WorkspaceRepository {
  constructor(private readonly db: CodingDatabase) {}

  upsertRepo(entry: RepoEntry): string {
    const id = stableRepoId(entry.key);
    this.db
      .insert(repositories)
      .values({
        id,
        key: entry.key,
        sourceUrl: entry.url,
        mirrorPath: entry.mirrorPath,
        defaultBranch: entry.defaultBranch ?? null,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })
      .onConflictDoUpdate({
        target: repositories.key,
        set: {
          sourceUrl: entry.url,
          mirrorPath: entry.mirrorPath,
          defaultBranch: entry.defaultBranch ?? null,
          updatedAt: entry.updatedAt,
        },
      })
      .run();
    return id;
  }

  save(manifest: WorkspaceManifest): WorkspaceManifest {
    transaction(this.db, () => {
      const workspaceId = workspaceKey(manifest.kind, manifest.name);
      this.db
        .insert(workspaces)
        .values({
          id: workspaceId,
          kind: manifest.kind,
          name: manifest.name,
          rootPath: manifest.rootPath,
          status: 'active',
          branch: manifest.branch ?? null,
          tmuxSession: manifest.tmuxSession ?? null,
          lastSyncedAt: null,
          createdAt: manifest.createdAt,
          updatedAt: manifest.updatedAt,
        })
        .onConflictDoUpdate({
          target: workspaces.id,
          set: {
            rootPath: manifest.rootPath,
            status: 'active',
            branch: manifest.branch ?? null,
            tmuxSession: manifest.tmuxSession ?? null,
            updatedAt: manifest.updatedAt,
          },
        })
        .run();
      this.db
        .delete(workspaceRepositories)
        .where(eq(workspaceRepositories.workspaceId, workspaceId))
        .run();
      for (const repo of manifest.repos) {
        this.db
          .insert(workspaceRepositories)
          .values({
            workspaceId,
            repositoryId: stableRepoId(repo.key),
            checkoutPath: repo.path,
            branch: repo.branch ?? null,
            status: 'active',
            lastGitStatus: null,
            lastSyncedAt: null,
            createdAt: manifest.createdAt,
            updatedAt: manifest.updatedAt,
          })
          .run();
      }
    });
    return manifest;
  }

  list(kind?: WorkspaceKind): readonly WorkspaceManifest[] {
    const rows = this.db
      .select()
      .from(workspaces)
      .where(kind === undefined ? undefined : eq(workspaces.kind, kind))
      .orderBy(asc(workspaces.rootPath))
      .all();
    return rows
      .filter((row) => row.status !== 'deleted')
      .map((row) => this.toManifest(row));
  }

  open(kind: WorkspaceKind, name: string): WorkspaceManifest | null {
    const row = this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.kind, kind), eq(workspaces.name, name)))
      .get();
    return row === undefined || row.status === 'deleted'
      ? null
      : this.toManifest(row);
  }

  markDeleted(kind: WorkspaceKind, name: string): void {
    const now = new Date().toISOString();
    this.db
      .update(workspaces)
      .set({ status: 'deleted', updatedAt: now })
      .where(and(eq(workspaces.kind, kind), eq(workspaces.name, name)))
      .run();
  }

  markArchived(manifest: WorkspaceManifest): WorkspaceManifest {
    const now = new Date().toISOString();
    this.db
      .update(workspaces)
      .set({
        status: 'archived',
        rootPath: manifest.rootPath,
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaces.kind, manifest.kind),
          eq(workspaces.name, manifest.name),
        ),
      )
      .run();
    return { ...manifest, updatedAt: now };
  }

  sync(
    diffs: readonly WorkspaceSyncDiff[],
    options: { readonly fixMissing?: boolean; readonly prune?: boolean } = {},
  ): WorkspaceSyncResult {
    const id = randomUUID();
    const now = new Date().toISOString();
    let fixedCount = 0;
    transaction(this.db, () => {
      for (const diff of diffs) {
        const workspaceId = workspaceKey(
          diff.workspace.kind,
          diff.workspace.name,
        );
        if (options.fixMissing === true && diff.missingRoot) {
          this.db
            .update(workspaces)
            .set({ status: 'missing', lastSyncedAt: now, updatedAt: now })
            .where(eq(workspaces.id, workspaceId))
            .run();
          fixedCount += 1;
        }
        for (const repo of diff.repos) {
          if (repo.status === 'active') {
            continue;
          }
          if (
            (options.fixMissing === true && repo.status === 'missing') ||
            (options.prune === true && repo.status === 'removed')
          ) {
            this.db
              .update(workspaceRepositories)
              .set({
                status: repo.status,
                lastGitStatus: repo.gitStatus ?? null,
                lastSyncedAt: now,
                updatedAt: now,
              })
              .where(
                and(
                  eq(workspaceRepositories.workspaceId, workspaceId),
                  eq(
                    workspaceRepositories.repositoryId,
                    stableRepoId(repo.key),
                  ),
                ),
              )
              .run();
            fixedCount += 1;
          }
        }
      }
      this.db
        .insert(workspaceSyncRuns)
        .values({
          id,
          workspaceId: null,
          status: 'completed',
          checkedCount: diffs.reduce((sum, diff) => sum + diff.repos.length, 0),
          fixedCount,
          errorMessage: null,
          startedAt: now,
          completedAt: new Date().toISOString(),
        })
        .run();
    });
    return {
      id,
      status: 'completed',
      checkedCount: diffs.reduce((sum, diff) => sum + diff.repos.length, 0),
      fixedCount,
      diffs,
    };
  }

  private toManifest(row: typeof workspaces.$inferSelect): WorkspaceManifest {
    const repoRows = this.db
      .select({
        key: repositories.key,
        checkoutPath: workspaceRepositories.checkoutPath,
        branch: workspaceRepositories.branch,
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
      key: repo.key,
      path: repo.checkoutPath,
      ...(repo.branch !== null ? { branch: repo.branch } : {}),
    }));
    return {
      name: row.name,
      kind: row.kind as WorkspaceKind,
      rootPath: row.rootPath,
      ...(row.branch !== null ? { branch: row.branch } : {}),
      ...(row.tmuxSession !== null ? { tmuxSession: row.tmuxSession } : {}),
      repos,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function workspaceKey(kind: string, name: string): string {
  return `${kind}:${name}`;
}

function stableRepoId(key: string): string {
  return `repo:${key}`;
}
