/**
 * 环境 feature 统一执行路径规范化、授权范围检查和运行期允许根计算。
 *
 * 所有文件系统和 shell 调用都通过本模块确认目标位于当前路径视图内。
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { isPathInside, resolveAbsolute } from '../tool/index.js';

/**
 * 将允许路径去重并转换为物理路径稳定的规范形式。
 *
 * Args:
 * - `paths`: 需要规范化的绝对或相对路径集合。
 *
 * Returns:
 * - 返回保持首次出现顺序的规范绝对路径集合。
 */
export function uniqueCanonicalPaths(
  paths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    ...new Set(paths.map((target) => canonicalTarget(path.resolve(target)))),
  ];
}

/**
 * 解析目标路径并确认其位于任一允许根目录中。
 *
 * Args:
 * - `cwd`: 所有相对目标的解析基准。
 * - `target`: 调用方提供的目标路径。
 * - `allowedPaths`: 当前操作允许访问的规范根目录集合。
 *
 * Returns:
 * - 返回已规范化且通过授权检查的绝对路径。
 *
 * Throws:
 * - 当目标位于允许根目录外时直接抛错。
 */
export function resolveAllowedTarget(
  cwd: string,
  target: string,
  allowedPaths: ReadonlyArray<string>,
): string {
  const resolved = canonicalTarget(resolveAbsolute(cwd, target));
  if (
    !allowedPaths.some((allowedPath) => isPathInside(allowedPath, resolved))
  ) {
    throw new Error(`Path not allowed: ${resolved}`);
  }
  return resolved;
}

/**
 * 将存在或尚未创建的目标转换为稳定的真实路径表示。
 *
 * Args:
 * - `target`: 需要转换的绝对路径。
 *
 * Returns:
 * - 返回已解析最近存在祖先后的规范绝对路径。
 *
 * Throws:
 * - 当目标不存在可解析的祖先路径时直接抛错。
 */
export function canonicalTarget(target: string): string {
  if (existsSync(target)) return realpathSync(target);
  let parent = path.dirname(target);
  while (!existsSync(parent) && path.dirname(parent) !== parent) {
    parent = path.dirname(parent);
  }
  if (!existsSync(parent)) {
    throw new Error(`Path has no existing ancestor: ${target}`);
  }
  return path.join(realpathSync(parent), path.relative(parent, target));
}

/**
 * 从当前工作目录、动态 permission 规则和 Thread 外部授权计算写根目录。
 *
 * Args:
 * - `cwd`: 运行工作目录的规范路径。
 * - `configuredPaths`: 配置层声明的允许路径。
 * - `rules`: 当前生效的 permission 规则快照。
 * - `threadExternalPaths`: 当前 Thread 已批准的外部路径快照。
 *
 * Returns:
 * - 返回去重后的可写规范根目录集合。
 */
export function runtimeAllowedPaths(
  cwd: string,
  configuredPaths: ReadonlyArray<string>,
  rules: ReadonlyArray<{
    readonly permission: string;
    readonly pattern: string;
    readonly action: string;
  }>,
  threadExternalPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const roots = [cwd, ...configuredPaths, ...threadExternalPaths];
  for (const rule of rules) {
    if (rule.permission === 'external_directory' && rule.action === 'allow') {
      roots.push(resolveAbsolute(cwd, rule.pattern));
    }
  }
  return uniqueCanonicalPaths(roots);
}
