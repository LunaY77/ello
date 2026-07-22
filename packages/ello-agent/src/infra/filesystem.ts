/**
 * 本文件负责基础设施层的“filesystem”模块职责。
 *
 * 外部进程、数据库、文件或遥测资源由显式参数和返回值限定所有权，不保存产品会话状态。
 * 适配边界只转换已声明的协议；资源错误保持原因并向调用方传播。
 */
import { access } from 'node:fs/promises';

import { isRecord } from '../protocol/json-value.js';

/**
 * 收窄 Node.js 文件系统错误，供 ENOENT/EEXIST 等显式分支读取稳定 `code`。
 *
 * Args:
 * - `error`: 文件系统边界捕获的未知失败值。
 *
 * Returns:
 * - 仅当值同时是 `Error` 且包含字符串 `code` 时返回 `true`。
 */
export function isErrnoException(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && isRecord(error) && typeof error.code === 'string'
  );
}

/**
 * 读取未知文件系统错误的 Node.js `code`。
 *
 * Args:
 * - `error`: 文件系统边界捕获的未知失败值。
 *
 * Returns:
 * - 返回字符串错误码；不是 `ErrnoException` 时显式返回 `undefined`。
 */
export function errnoCode(error: unknown): string | undefined {
  return isErrnoException(error) ? error.code : undefined;
}

/**
 * 执行 基础设施层的 `filesystem` 模块 定义的 `pathExists` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `target`: `pathExists` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - Promise 在 基础设施层的 `filesystem` 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}
