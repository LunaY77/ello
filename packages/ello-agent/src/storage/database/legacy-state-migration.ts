import { existsSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export interface LegacyStateMigrationReport {
  readonly repositories: number;
  readonly workspaces: number;
  readonly workspaceRepositories: number;
}

/**
 * Imports the registry tables from the pre-client/server state database.
 *
 * The refactor moved the live database from `~/.ello/state.sqlite` to
 * `~/.ello/state/ello.sqlite`.  The old database is deliberately opened
 * read-only and is never removed; inserts are idempotent so restarting the
 * Server is safe while a user still has the legacy file around.
 */
export function migrateLegacyStateDatabase(
  client: Database.Database,
  legacyDatabasePath: string,
): LegacyStateMigrationReport | undefined {
  if (path.resolve(client.name) === path.resolve(legacyDatabasePath)) {
    return undefined;
  }
  if (!existsSync(legacyDatabasePath)) {
    return undefined;
  }

  const legacy = new Database(legacyDatabasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rows = readLegacyRows(legacy);
    if (rows === undefined) {
      return undefined;
    }

    return client.transaction(() => importRows(client, rows))();
  } finally {
    legacy.close();
  }
}

interface LegacyRows {
  readonly repositories: readonly LegacyRepositoryRow[];
  readonly workspaces: readonly LegacyWorkspaceRow[];
  readonly workspaceRepositories: readonly LegacyWorkspaceRepositoryRow[];
}

interface LegacyRepositoryRow {
  readonly id: string;
  readonly key: string;
  readonly remoteUrl: string | null;
  readonly mirrorPath: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface LegacyWorkspaceRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly rootPath: string;
  readonly status: string;
  readonly branch: string | null;
  readonly tmuxSession: string | null;
  readonly lastSyncedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface LegacyWorkspaceRepositoryRow {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly checkoutPath: string;
  readonly checkoutRole: string;
  readonly checkoutMode: string;
  readonly branch: string | null;
  readonly headCommit: string | null;
  readonly status: string;
  readonly lastGitStatus: string | null;
  readonly lastSyncedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function readLegacyRows(database: Database.Database): LegacyRows | undefined {
  if (
    !hasTable(database, 'repositories') ||
    !hasTable(database, 'workspaces') ||
    !hasTable(database, 'workspace_repositories')
  ) {
    return undefined;
  }

  const repositoryRemoteColumn = hasColumn(
    database,
    'repositories',
    'remote_url',
  )
    ? 'remote_url'
    : hasColumn(database, 'repositories', 'source_url')
      ? 'source_url'
      : undefined;
  if (
    repositoryRemoteColumn === undefined ||
    !hasColumns(database, 'repositories', [
      'id',
      'key',
      'mirror_path',
      'default_branch',
      'created_at',
      'updated_at',
    ]) ||
    !hasColumns(database, 'workspaces', [
      'id',
      'kind',
      'name',
      'root_path',
      'status',
      'branch',
      'tmux_session',
      'last_synced_at',
      'created_at',
      'updated_at',
    ]) ||
    !hasColumns(database, 'workspace_repositories', [
      'workspace_id',
      'repository_id',
      'checkout_path',
      'branch',
      'head_commit',
      'status',
      'last_git_status',
      'last_synced_at',
      'created_at',
      'updated_at',
    ])
  ) {
    return undefined;
  }

  const repositories = database
    .prepare(
      `select id, key, ${repositoryRemoteColumn} as remote_url,
              mirror_path, default_branch, created_at, updated_at
       from repositories`,
    )
    .all()
    .map((row) => {
      const value = row as Record<string, unknown>;
      return {
        id: requiredText(value.id, 'repositories.id'),
        key: requiredText(value.key, 'repositories.key'),
        remoteUrl: optionalText(value.remote_url, 'repositories.remote_url'),
        mirrorPath: requiredText(value.mirror_path, 'repositories.mirror_path'),
        defaultBranch: requiredText(
          value.default_branch,
          'repositories.default_branch',
        ),
        createdAt: requiredText(value.created_at, 'repositories.created_at'),
        updatedAt: requiredText(value.updated_at, 'repositories.updated_at'),
      } satisfies LegacyRepositoryRow;
    });

  const workspaces = database
    .prepare(
      `select id, kind, name, root_path, status, branch, tmux_session,
              last_synced_at, created_at, updated_at
       from workspaces`,
    )
    .all()
    .map((row) => {
      const value = row as Record<string, unknown>;
      return {
        id: requiredText(value.id, 'workspaces.id'),
        kind: requiredText(value.kind, 'workspaces.kind'),
        name: requiredText(value.name, 'workspaces.name'),
        rootPath: requiredText(value.root_path, 'workspaces.root_path'),
        status: requiredText(value.status, 'workspaces.status'),
        branch: optionalText(value.branch, 'workspaces.branch'),
        tmuxSession: optionalText(
          value.tmux_session,
          'workspaces.tmux_session',
        ),
        lastSyncedAt: optionalText(
          value.last_synced_at,
          'workspaces.last_synced_at',
        ),
        createdAt: requiredText(value.created_at, 'workspaces.created_at'),
        updatedAt: requiredText(value.updated_at, 'workspaces.updated_at'),
      } satisfies LegacyWorkspaceRow;
    });

  const hasCheckoutMode = hasColumn(
    database,
    'workspace_repositories',
    'checkout_mode',
  );
  const hasCheckoutRole = hasColumn(
    database,
    'workspace_repositories',
    'checkout_role',
  );
  const workspaceRepositories = database
    .prepare(
      `select workspace_id, repository_id, checkout_path,
              ${hasCheckoutRole ? 'checkout_role' : 'null'} as checkout_role,
              ${hasCheckoutMode ? 'checkout_mode' : 'null'} as checkout_mode,
              branch, head_commit, status, last_git_status, last_synced_at,
              created_at, updated_at
       from workspace_repositories`,
    )
    .all()
    .map((row) => {
      const value = row as Record<string, unknown>;
      const branch = optionalText(
        value.branch,
        'workspace_repositories.branch',
      );
      return {
        workspaceId: requiredText(
          value.workspace_id,
          'workspace_repositories.workspace_id',
        ),
        repositoryId: requiredText(
          value.repository_id,
          'workspace_repositories.repository_id',
        ),
        checkoutPath: requiredText(
          value.checkout_path,
          'workspace_repositories.checkout_path',
        ),
        checkoutRole:
          optionalText(
            value.checkout_role,
            'workspace_repositories.checkout_role',
          ) ?? 'development',
        checkoutMode:
          optionalText(
            value.checkout_mode,
            'workspace_repositories.checkout_mode',
          ) ?? (branch === null ? 'detached' : 'branch'),
        branch,
        headCommit: optionalText(
          value.head_commit,
          'workspace_repositories.head_commit',
        ),
        status: requiredText(value.status, 'workspace_repositories.status'),
        lastGitStatus: optionalText(
          value.last_git_status,
          'workspace_repositories.last_git_status',
        ),
        lastSyncedAt: optionalText(
          value.last_synced_at,
          'workspace_repositories.last_synced_at',
        ),
        createdAt: requiredText(
          value.created_at,
          'workspace_repositories.created_at',
        ),
        updatedAt: requiredText(
          value.updated_at,
          'workspace_repositories.updated_at',
        ),
      } satisfies LegacyWorkspaceRepositoryRow;
    });

  return { repositories, workspaces, workspaceRepositories };
}

function importRows(
  client: Database.Database,
  rows: LegacyRows,
): LegacyStateMigrationReport {
  const repositoryIds = new Map<string, string>();
  const workspaceIds = new Map<string, string>();
  let importedRepositories = 0;
  let importedWorkspaces = 0;
  let importedWorkspaceRepositories = 0;

  const findRepositoryById = client.prepare(
    'select id from repositories where id = ?',
  );
  const findRepositoryByKey = client.prepare(
    'select id from repositories where key = ?',
  );
  const insertRepository = client.prepare(
    `insert or ignore into repositories
       (id, key, remote_url, mirror_path, default_branch, created_at, updated_at)
     values (@id, @key, @remoteUrl, @mirrorPath, @defaultBranch, @createdAt, @updatedAt)`,
  );
  for (const repository of rows.repositories) {
    let existing =
      (findRepositoryById.get(repository.id) as { id?: unknown } | undefined)
        ?.id ??
      (findRepositoryByKey.get(repository.key) as { id?: unknown } | undefined)
        ?.id;
    if (existing === undefined) {
      importedRepositories += insertRepository.run(repository).changes;
      existing =
        (findRepositoryById.get(repository.id) as { id?: unknown } | undefined)
          ?.id ??
        (
          findRepositoryByKey.get(repository.key) as
            | { id?: unknown }
            | undefined
        )?.id;
    }
    const id =
      typeof existing === 'string'
        ? existing
        : (() => {
            throw new Error(
              `Legacy repository could not be imported: ${repository.key}.`,
            );
          })();
    repositoryIds.set(repository.id, id);
  }

  const findWorkspaceById = client.prepare(
    'select id from workspaces where id = ?',
  );
  const findActiveWorkspace = client.prepare(
    `select id from workspaces
     where kind = ? and name = ? and status in ('active', 'missing')`,
  );
  const insertWorkspace = client.prepare(
    `insert or ignore into workspaces
       (id, kind, name, root_path, status, branch, tmux_session,
        last_synced_at, created_at, updated_at)
     values (@id, @kind, @name, @rootPath, @status, @branch, @tmuxSession,
             @lastSyncedAt, @createdAt, @updatedAt)`,
  );
  for (const workspace of rows.workspaces) {
    let existing =
      (findWorkspaceById.get(workspace.id) as { id?: unknown } | undefined)
        ?.id ??
      (
        findActiveWorkspace.get(workspace.kind, workspace.name) as
          | { id?: unknown }
          | undefined
      )?.id;
    if (existing === undefined) {
      importedWorkspaces += insertWorkspace.run(workspace).changes;
      existing =
        (findWorkspaceById.get(workspace.id) as { id?: unknown } | undefined)
          ?.id ??
        (
          findActiveWorkspace.get(workspace.kind, workspace.name) as
            | { id?: unknown }
            | undefined
        )?.id;
    }
    const id =
      typeof existing === 'string'
        ? existing
        : (() => {
            throw new Error(
              `Legacy workspace could not be imported: ${workspace.kind}/${workspace.name}.`,
            );
          })();
    workspaceIds.set(workspace.id, id);
  }

  const insertWorkspaceRepository = client.prepare(
    `insert or ignore into workspace_repositories
       (workspace_id, repository_id, checkout_path, checkout_role,
        checkout_mode, branch, head_commit, status, last_git_status,
        last_synced_at, created_at, updated_at)
     values (@workspaceId, @repositoryId, @checkoutPath, @checkoutRole,
             @checkoutMode, @branch, @headCommit, @status, @lastGitStatus,
             @lastSyncedAt, @createdAt, @updatedAt)`,
  );
  for (const relation of rows.workspaceRepositories) {
    const workspaceId = workspaceIds.get(relation.workspaceId);
    const repositoryId = repositoryIds.get(relation.repositoryId);
    if (workspaceId === undefined || repositoryId === undefined) {
      throw new Error(
        `Legacy workspace relation references missing entities: ${relation.workspaceId}/${relation.repositoryId}.`,
      );
    }
    importedWorkspaceRepositories += insertWorkspaceRepository.run({
      ...relation,
      workspaceId,
      repositoryId,
    }).changes;
  }

  return {
    repositories: importedRepositories,
    workspaces: importedWorkspaces,
    workspaceRepositories: importedWorkspaceRepositories,
  };
}

function hasTable(database: Database.Database, table: string): boolean {
  return (
    database
      .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
      .get(table) !== undefined
  );
}

function hasColumn(
  database: Database.Database,
  table: string,
  column: string,
): boolean {
  return database
    .prepare(`pragma table_info(${table})`)
    .all()
    .some((row) => (row as { name?: unknown }).name === column);
}

function hasColumns(
  database: Database.Database,
  table: string,
  columns: readonly string[],
): boolean {
  const available = new Set(
    database
      .prepare(`pragma table_info(${table})`)
      .all()
      .map((row) => (row as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string'),
  );
  return columns.every((column) => available.has(column));
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Legacy database field ${field} is missing.`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Legacy database field ${field} is not text.`);
  }
  return value;
}
