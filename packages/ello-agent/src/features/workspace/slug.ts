/**
 * 本文件负责 workspace feature 的“slug”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { WorkspaceKind } from './types.js';

/**
 * 校验 workspace 类型。
 *
 * Args:
 * - `value`: 要由 `validateKind` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `validateKind` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Workspace `slug` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function validateKind(value: string): WorkspaceKind {
  if (
    value === 'feature' ||
    value === 'fix' ||
    value === 'refactor' ||
    value === 'explore'
  ) {
    return value;
  }
  throw new Error(`Invalid workspace kind: ${value}`);
}

/**
 * 把用户输入转换成可作为目录名和分支名的 slug。
 *
 * Args:
 * - `value`: 要由 `slugify` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `slugify` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (slug === '') {
    throw new Error('Workspace name cannot be empty.');
  }
  return slug;
}
