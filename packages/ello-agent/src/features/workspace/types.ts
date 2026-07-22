/**
 * 本文件负责 workspace feature 的领域类型与闭合联合。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
export type WorkspaceKind = 'feature' | 'fix' | 'refactor' | 'explore';
export type WorkspaceStatus = 'active' | 'archived' | 'missing' | 'deleted';
export type CheckoutMode = 'branch' | 'detached';
export type WorkspaceRepoRole = 'development' | 'reference';

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
