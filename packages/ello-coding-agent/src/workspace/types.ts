export type WorkspaceKind = 'feature' | 'fix' | 'explore';

export interface RepoEntry {
  readonly key: string;
  readonly url: string;
  readonly mirrorPath: string;
  readonly defaultBranch?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceRepo {
  readonly key: string;
  readonly path: string;
  readonly branch?: string | undefined;
}

export interface WorkspaceManifest {
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly rootPath: string;
  readonly branch?: string | undefined;
  readonly tmuxSession?: string | undefined;
  readonly repos: readonly WorkspaceRepo[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
