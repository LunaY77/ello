/**
 * 环境 feature 的路径视图、文件系统 adapter 与本地装配输入契约。
 *
 * 该模块只描述路径授权和 I/O 组合，不持有 Thread、配置或资源实例。
 */
import type { stat } from 'node:fs/promises';

import type { AgentFileSystem, AgentShell } from '../agent/engine/contracts.js';

export interface CreateLocalEnvironmentOptions {
  readonly cwd: string;
  readonly allowedPaths: ReadonlyArray<string>;
  readonly shellExecutable?: string;
  readonly shell?: AgentShell;
}

export type PolicyFileSystem = AgentFileSystem & {
  resolvePath(targetPath: string): string;
  stat(targetPath: string): ReturnType<typeof stat>;
};

export interface EnvironmentPaths {
  /**
   * 返回当前读操作允许访问的规范路径集合。
   *
   * Args:
   * - 无：路径由环境创建方持有。
   *
   * Returns:
   * - 返回只读路径快照；调用方不能修改底层授权状态。
   */
  read(): ReadonlyArray<string>;
  /**
   * 返回当前写操作允许访问的规范路径集合。
   *
   * Args:
   * - 无：路径由环境创建方持有。
   *
   * Returns:
   * - 返回只读路径快照；调用方不能修改底层授权状态。
   */
  write(): ReadonlyArray<string>;
}

export interface CreateEnvironmentOptions {
  readonly cwd: string;
  readonly paths: EnvironmentPaths;
  readonly includeInstructions: boolean;
  readonly shellExecutable?: string;
  readonly shell?: AgentShell;
}
