/**
 * 本文件负责 memory feature 的路径推导与路径约束。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import path from 'node:path';

import type { CodingAgentConfig } from '../../config/index.js';

export type MemoryScope = 'private' | 'team';

export interface MemoryRoots {
  readonly private: string;
  readonly team: string;
}

/**
 * 执行 Memory `paths` 模块 定义的 `memoryRoots` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 *
 * Returns:
 * - 返回 `memoryRoots` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function memoryRoots(config: CodingAgentConfig): MemoryRoots {
  return {
    private: path.resolve(config.context.memory.private_dir),
    team: path.resolve(config.context.memory.team_dir),
  };
}

/**
 * 执行 Memory `paths` 模块 定义的 `memoryRoot` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `roots`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 * - `scope`: `memoryRoot` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `memoryRoot` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function memoryRoot(roots: MemoryRoots, scope: MemoryScope): string {
  return roots[scope];
}

/**
 * 执行 Memory `paths` 模块 定义的 `memoryIndexPath` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `roots`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 * - `scope`: `memoryIndexPath` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `memoryIndexPath` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function memoryIndexPath(
  roots: MemoryRoots,
  scope: MemoryScope,
): string {
  return path.join(memoryRoot(roots, scope), 'MEMORY.md');
}
