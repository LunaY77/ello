export type WorkspaceKind = 'feature' | 'fix' | 'explore';
export type WorkspaceStatus = 'active' | 'archived' | 'missing' | 'deleted';
export type CheckoutMode = 'branch' | 'detached';
export type WorkspaceRepoRole = 'development' | 'reference';

export interface Repository {
  readonly id: string;
  readonly key: string;
  readonly mirrorPath: string;
  readonly remoteUrl: string | null;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceRepo {
  readonly repositoryId: string;
  readonly key: string;
  readonly path: string;
  readonly role: WorkspaceRepoRole;
  readonly checkoutMode: CheckoutMode;
  readonly branch: string | null;
  readonly headCommit: string | null;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly rootPath: string;
  readonly status: WorkspaceStatus;
  readonly branch: string | null;
  readonly tmuxSession: string | null;
  readonly repos: readonly WorkspaceRepo[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RepoExportDocument {
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly repositories: readonly {
    readonly key: string;
    readonly remoteUrl: string | null;
    readonly defaultBranch: string;
    readonly bundle?: string;
  }[];
}
