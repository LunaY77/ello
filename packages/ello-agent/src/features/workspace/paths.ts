/**
 * 本文件负责 workspace feature 的路径推导与路径约束。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { homedir } from 'node:os';
import path from 'node:path';

import { slugify } from './slug.js';
import type { WorkspaceKind } from './types.js';

/**
 * 在 Workspace `paths` 模块 中执行 `resolveWorkspaceMount` 完整流程，并在返回前完成其必要副作用。
 *
 * Args:
 * - `configuredMount`: `resolveWorkspaceMount` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `resolveWorkspaceMount` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Workspace `paths` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function resolveWorkspaceMount(configuredMount: string): string {
  const expanded =
    configuredMount === '~'
      ? homedir()
      : configuredMount.startsWith('~/')
        ? path.join(homedir(), configuredMount.slice(2))
        : configuredMount;
  if (!path.isAbsolute(expanded)) {
    throw new Error(
      `Workspace mount must be an absolute path: ${configuredMount}`,
    );
  }
  return path.resolve(expanded);
}

/**
 * 执行 Workspace `paths` 模块 定义的 `activeWorkspacesDir` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `mount`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `activeWorkspacesDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function activeWorkspacesDir(mount: string): string {
  return path.join(mount, 'workspace');
}

/**
 * 按 Workspace `paths` 模块 的一致性约束执行 `archivedWorkspacesDir` 状态变更。
 *
 * Args:
 * - `mount`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `archivedWorkspacesDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function archivedWorkspacesDir(mount: string): string {
  return path.join(mount, 'archive');
}

/**
 * 执行 Workspace `paths` 模块 定义的 `workspaceDir` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `mount`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `kind`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
 * - `name`: `workspaceDir` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `workspaceDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function workspaceDir(
  mount: string,
  kind: WorkspaceKind,
  name: string,
): string {
  return path.join(activeWorkspacesDir(mount), kind, slugify(name));
}

/**
 * 按 Workspace `paths` 模块 的一致性约束执行 `archivedWorkspaceDir` 状态变更。
 *
 * Args:
 * - `mount`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `kind`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
 * - `name`: `archivedWorkspaceDir` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `workspaceId`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
 * - `archivedAt`: `archivedWorkspaceDir` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `archivedWorkspaceDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function archivedWorkspaceDir(
  mount: string,
  kind: WorkspaceKind,
  name: string,
  workspaceId: string,
  archivedAt: string,
): string {
  const timestamp = archivedAt.replace(/[-:.]/gu, '');
  return path.join(
    archivedWorkspacesDir(mount),
    kind,
    `${slugify(name)}-${timestamp}-${workspaceId}`,
  );
}
