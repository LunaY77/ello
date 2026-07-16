import path from 'node:path';

import { slugify, validateKind, validateRepoKey } from './slug.js';
import type {
  Repository,
  WorkspaceKind,
  WorkspaceRepo,
  WorkspaceRepoRole,
} from './types.js';

export interface WorkspaceCreatePlan {
  readonly kind: WorkspaceKind;
  readonly name: string;
  readonly rootPath: string;
  readonly branch: string | null;
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
  const repoKeys = input.repoKeys.map(validateRepoKey);
  if (new Set(repoKeys).size !== repoKeys.length) {
    throw new Error('Workspace repository keys must be unique');
  }
  return {
    kind,
    name,
    rootPath: input.rootPath,
    branch: kind === 'explore' ? null : `${kind}/${name}`,
    repoKeys,
  };
}

export function planWorkspaceRepo(
  rootPath: string,
  repository: Repository,
  branch: string | null,
  role: WorkspaceRepoRole,
): WorkspaceRepo {
  if (role === 'reference' && branch !== null) {
    throw new Error(`Workspace reference must be detached: ${repository.key}`);
  }
  return {
    repositoryId: repository.id,
    key: repository.key,
    path: path.join(
      rootPath,
      role === 'reference' ? 'references' : 'repos',
      repository.key,
    ),
    role,
    checkoutMode: branch === null ? 'detached' : 'branch',
    branch,
    headCommit: null,
  };
}
