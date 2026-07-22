/**
 * 本文件负责 workspace feature 的Plan 文件状态。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import path from 'node:path';

import { validateRepoKey, type Repository } from './repository.js';
import { slugify, validateKind } from './slug.js';
import type {
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

/**
 * 执行 Workspace `plan` 模块 定义的 `planWorkspaceCreate` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `input`: `planWorkspaceCreate` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `planWorkspaceCreate` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
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

/**
 * 执行 Workspace `plan` 模块 定义的 `planWorkspaceRepo` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `rootPath`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `repository`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
 * - `branch`: `planWorkspaceRepo` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `role`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
 *
 * Returns:
 * - 返回 `planWorkspaceRepo` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
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
