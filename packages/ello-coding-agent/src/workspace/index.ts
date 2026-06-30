import type { RepoEntry, WorkspaceManifest } from './types.js';

export { RepoStore } from './repo-store.js';
export { TmuxStore } from './tmux.js';
export { WorkspaceStore } from './workspace-store.js';
export type {
  RepoEntry,
  WorkspaceKind,
  WorkspaceManifest,
  WorkspaceRepo,
} from './types.js';

export function formatRepoList(repos: readonly RepoEntry[]): string {
  if (repos.length === 0) {
    return 'repos\t<none>';
  }
  return repos
    .map(
      (repo) =>
        `${repo.key}\t${repo.defaultBranch ?? '<unknown>'}\t${repo.url}`,
    )
    .join('\n');
}

export function formatWorkspaceList(
  workspaces: readonly WorkspaceManifest[],
): string {
  if (workspaces.length === 0) {
    return 'workspaces\t<none>';
  }
  return workspaces
    .map(
      (workspace) =>
        `${workspace.kind}\t${workspace.name}\t${workspace.repos.map((repo) => repo.key).join(',')}\t${workspace.rootPath}`,
    )
    .join('\n');
}
