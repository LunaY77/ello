/**
 * 本文件负责 Workspace 与 Repository 统一领域的公开入口与 factory。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createRepositoryRoutes } from './repository-routes.js';
import type { RepositoryStore } from './repository-store.js';
import type { Repository } from './repository.js';
import { createWorkspaceRoutes } from './routes.js';
import type { WorkspaceRecordStore } from './store.js';
import type { Workspace } from './types.js';

/**
 * 构造 Workspace 公开入口 模块 中的 `createWorkspaceFeature` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `input`: `createWorkspaceFeature` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `createWorkspaceFeature` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Workspace 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createWorkspaceFeature(input: {
  readonly repositories: RepositoryStore;
  readonly workspaces: WorkspaceRecordStore;
}) {
  return {
    routes: {
      ...createRepositoryRoutes(input.repositories),
      ...createWorkspaceRoutes(input),
    },
  };
}

export {
  assertRepositoryUserBranch,
  REPOSITORY_BASELINE_REF,
  RepoStore,
  type FetchResult,
} from './repositories.js';
export {
  createRepositoryStore,
  type RepositoryStore,
} from './repository-store.js';
export {
  RepoExportDocumentSchema,
  validateRepoKey,
  type RepoExportDocument,
  type Repository,
} from './repository.js';
export { TmuxStore } from './tmux.js';
export {
  createWorkspaceRecordStore,
  type WorkspaceRecordStore,
} from './store.js';
export { WorkspaceStore, type WorkspaceStatusView } from './workspaces.js';
export type {
  CheckoutMode,
  Workspace,
  WorkspaceKind,
  WorkspaceRepo,
  WorkspaceRepoRole,
  WorkspaceStatus,
} from './types.js';

/**
 * 执行 Workspace 公开入口 模块 定义的 `formatWorkspaceList` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `workspaces`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `formatWorkspaceList` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function formatWorkspaceList(
  workspaces: ReadonlyArray<Workspace>,
): string {
  if (workspaces.length === 0) return 'workspaces\t<none>';
  return workspaces
    .map(
      (workspace) =>
        `${workspace.id}\t${workspace.kind}\t${workspace.name}\t${workspace.status}\t${workspace.repos.map((repo) => repo.key).join(',')}\t${workspace.rootPath}`,
    )
    .join('\n');
}

/**
 * 将 Workspace 领域登记的 repositories 格式化为稳定的 CLI 文本。
 *
 * Args:
 * - `repos`: 按 key 排列的 repository 视图；函数不修改调用方集合。
 *
 * Returns:
 * - 返回适合非 JSON CLI 输出的制表符分隔文本。
 */
export function formatRepoList(repos: ReadonlyArray<Repository>): string {
  if (repos.length === 0) return 'repos\t<none>';
  return repos
    .map(
      (repo) =>
        `${repo.key}\t${repo.defaultBranch}\t${repo.remoteUrl ?? '<local-only>'}`,
    )
    .join('\n');
}
