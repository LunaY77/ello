/**
 * 环境 feature 为产品运行创建动态 permission 和 Skill 路径驱动的环境。
 *
 * 运行 factory 由 composition root 注入，Agent feature 不直接依赖本地实现。
 */
import path from 'node:path';

import type { SessionMode } from '../../protocol/v1/index.js';
import type { AgentEnvironment } from '../agent/engine/contracts.js';
import type { CodingAgentConfig } from '../config/index.js';

import { createEnvironment } from './factory.js';
import {
  canonicalTarget,
  runtimeAllowedPaths,
  uniqueCanonicalPaths,
} from './paths.js';

/**
 * 创建读取动态 permission 状态的产品运行环境。
 *
 * Args:
 * - `config`: 当前运行已验证的配置；其中 `cwd` 是所有相对路径的唯一基准。
 * - `rules`: 每次 I/O 前读取当前 permission rules，确保 session 级授权立即生效。
 * - `threadExternalPaths`: 每次 I/O 前读取 Thread 持有的临时外部路径。
 * - `mode`: 每次 I/O 前读取 session mode；bypass 允许访问当前文件系统根下的任意路径。
 * - `skillReadRoots`: 每次读操作前读取 Skill 内容根；这些路径不进入写权限集合。
 *
 * Returns:
 * - 返回与单次 BuiltAgent 生命周期一致的环境。
 */
export function createRuntimeEnvironment(
  config: CodingAgentConfig,
  rules: () => ReadonlyArray<{
    readonly permission: string;
    readonly pattern: string;
    readonly action: string;
  }>,
  threadExternalPaths: () => ReadonlyArray<string>,
  mode: () => SessionMode,
  skillReadRoots: () => ReadonlyArray<string>,
): AgentEnvironment {
  const cwd = canonicalTarget(path.resolve(config.cwd));
  const writePaths = () =>
    mode() === 'bypass'
      ? [path.parse(cwd).root]
      : runtimeAllowedPaths(cwd, rules(), threadExternalPaths());
  return createEnvironment({
    cwd,
    paths: {
      write: writePaths,
      read: () => uniqueCanonicalPaths([...writePaths(), ...skillReadRoots()]),
    },
    includeInstructions: false,
  });
}
