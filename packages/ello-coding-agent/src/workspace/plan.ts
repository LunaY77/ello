import path from 'node:path';

import { slugify, validateKind, validateRepoKey } from './slug.js';
import type {
  WorkspaceKind,
  WorkspaceManifest,
  WorkspaceRepo,
} from './types.js';

export type WorkspaceRepoSyncStatus = 'active' | 'missing' | 'dirty';

export interface WorkspaceCreatePlan {
  readonly kind: WorkspaceKind;
  readonly name: string;
  readonly rootPath: string;
  readonly branch?: string | undefined;
  readonly repoKeys: readonly string[];
}

export function planWorkspaceCreate(input: {
  readonly kind: string;
  readonly name: string;
  readonly rootPath: string;
  readonly repoKeys: readonly string[];
}): WorkspaceCreatePlan {
  const kind = validateKind(input.kind);
  const name = slugify(input.name);
  return {
    kind,
    name,
    rootPath: input.rootPath,
    ...(kind !== 'explore' ? { branch: `${kind}/${name}` } : {}),
    repoKeys: input.repoKeys.map(validateRepoKey),
  };
}

export function buildWorkspaceManifest(input: {
  readonly plan: WorkspaceCreatePlan;
  readonly repos: readonly WorkspaceRepo[];
  readonly now: string;
  readonly tmuxSession?: string | undefined;
}): WorkspaceManifest {
  return {
    name: input.plan.name,
    kind: input.plan.kind,
    rootPath: input.plan.rootPath,
    ...(input.plan.branch !== undefined ? { branch: input.plan.branch } : {}),
    ...(input.tmuxSession !== undefined ? { tmuxSession: input.tmuxSession } : {}),
    repos: input.repos,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function planWorkspaceRepo(input: {
  readonly rootPath: string;
  readonly kind: WorkspaceKind;
  readonly workspaceName: string;
  readonly branch?: string | undefined;
  readonly key: string;
}): WorkspaceRepo {
  const key = validateRepoKey(input.key);
  return {
    key,
    path: path.join(input.rootPath, key),
    ...(input.branch !== undefined
      ? { branch: input.branch }
      : { branch: `${input.workspaceName}-detached` }),
  };
}

export function addWorkspaceRepos(
  manifest: WorkspaceManifest,
  repos: readonly WorkspaceRepo[],
  now: string,
): WorkspaceManifest {
  return {
    ...manifest,
    repos: [...manifest.repos, ...repos],
    updatedAt: now,
  };
}

export function removeWorkspaceRepos(
  manifest: WorkspaceManifest,
  repoKeys: readonly string[],
  now: string,
): WorkspaceManifest {
  const removing = new Set(repoKeys.map(validateRepoKey));
  return {
    ...manifest,
    repos: manifest.repos.filter((repo) => !removing.has(repo.key)),
    updatedAt: now,
  };
}

export function renameWorkspace(
  manifest: WorkspaceManifest,
  targetRootPath: string,
  newNameInput: string,
  now: string,
): WorkspaceManifest {
  const newName = slugify(newNameInput);
  return {
    ...manifest,
    name: newName,
    rootPath: targetRootPath,
    repos: manifest.repos.map((repo) => ({
      ...repo,
      path: path.join(targetRootPath, path.relative(manifest.rootPath, repo.path)),
    })),
    updatedAt: now,
  };
}

export function archiveWorkspace(
  manifest: WorkspaceManifest,
  targetRootPath: string,
  now: string,
): WorkspaceManifest {
  return {
    ...manifest,
    rootPath: targetRootPath,
    updatedAt: now,
  };
}

export function classifyWorkspaceRepo(input: {
  readonly repo: WorkspaceRepo;
  readonly exists: boolean;
  readonly gitStatus?: string | undefined;
}): {
  readonly key: string;
  readonly path: string;
  readonly status: WorkspaceRepoSyncStatus;
  readonly gitStatus?: string | undefined;
} {
  if (!input.exists) {
    return {
      key: input.repo.key,
      path: input.repo.path,
      status: 'missing',
    };
  }
  const gitStatus = input.gitStatus ?? '';
  return {
    key: input.repo.key,
    path: input.repo.path,
    status: gitStatus === '' ? 'active' : 'dirty',
    ...(gitStatus !== '' ? { gitStatus } : {}),
  };
}
