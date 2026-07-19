import type { Repository, Workspace } from './types.js';

export {
  REPOSITORY_BASELINE_REF,
  RepoStore,
  type FetchResult,
} from './repo-store.js';
export { TmuxStore } from './tmux.js';
export { WorkspaceStore, type WorkspaceStatusView } from './workspace-store.js';
export type {
  CheckoutMode,
  RepoExportDocument,
  Repository,
  Workspace,
  WorkspaceKind,
  WorkspaceRepo,
  WorkspaceRepoRole,
  WorkspaceStatus,
} from './types.js';

export function formatRepoList(repos: readonly Repository[]): string {
  if (repos.length === 0) return 'repos\t<none>';
  return repos
    .map(
      (repo) =>
        `${repo.key}\t${repo.defaultBranch}\t${repo.remoteUrl ?? '<local-only>'}`,
    )
    .join('\n');
}

export function formatWorkspaceList(workspaces: readonly Workspace[]): string {
  if (workspaces.length === 0) return 'workspaces\t<none>';
  return workspaces
    .map(
      (workspace) =>
        `${workspace.id}\t${workspace.kind}\t${workspace.name}\t${workspace.status}\t${workspace.repos.map((repo) => repo.key).join(',')}\t${workspace.rootPath}`,
    )
    .join('\n');
}
