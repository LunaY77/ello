/**
 * 环境 feature 创建使用静态路径白名单的本地 Agent 环境。
 *
 * 静态环境适用于独立 engine 使用场景，路径在创建时规范化并冻结。
 */
import path from 'node:path';

import { resolveAbsolute } from '../tool/index.js';

import type { CreateLocalEnvironmentOptions } from './contracts.js';
import { createEnvironment } from './factory.js';
import { canonicalTarget, uniqueCanonicalPaths } from './paths.js';

/**
 * 创建使用静态路径白名单的本地 Agent 环境。
 *
 * Args:
 * - `options`: 指定规范工作目录、非空允许路径和可选 shell executable；路径在创建时冻结。
 *
 * Returns:
 * - 返回拥有文件系统、shell 和资源注册表的环境；调用方负责执行 `close()`。
 *
 * Throws:
 * - 当允许路径为空或路径无法规范化时直接抛错。
 */
export function createLocalEnvironment(options: CreateLocalEnvironmentOptions) {
  if (options.allowedPaths.length === 0) {
    throw new Error(
      'Local Agent environment requires at least one allowed path.',
    );
  }
  const cwd = canonicalTarget(path.resolve(options.cwd));
  const allowedPaths = uniqueCanonicalPaths(
    options.allowedPaths.map((allowedPath) =>
      resolveAbsolute(cwd, allowedPath),
    ),
  );
  return createEnvironment({
    cwd,
    paths: {
      read: () => allowedPaths,
      write: () => allowedPaths,
    },
    includeInstructions: true,
    ...(options.shellExecutable === undefined
      ? {}
      : { shellExecutable: options.shellExecutable }),
    ...(options.shell === undefined ? {} : { shell: options.shell }),
  });
}
