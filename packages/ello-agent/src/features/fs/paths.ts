/**
 * 本文件负责 fs feature 的路径推导与路径约束。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { AppServerError } from '../../protocol/v1/index.js';

/**
 * 词法检查与 realpath 检查必须同时成立，避免符号链接绕过 workspace 边界。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `target`: `existingPathInside` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - Promise 在 文件系统 `paths` 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export async function existingPathInside(
  cwd: string,
  target: string,
): Promise<string> {
  const lexical = lexicalPathInside(cwd, target);
  const canonical = await realpath(lexical);
  assertPathInside(cwd, canonical);
  return canonical;
}

/**
 * 执行 文件系统 `paths` 模块 定义的 `lexicalPathInside` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `target`: `lexicalPathInside` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `lexicalPathInside` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function lexicalPathInside(cwd: string, target: string): string {
  const root = path.resolve(cwd);
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(root, target);
  assertPathInside(root, resolved);
  return resolved;
}

function assertPathInside(cwd: string, target: string): void {
  const relative = path.relative(path.resolve(cwd), path.resolve(target));
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new AppServerError({
    type: 'pathOutsideWorkspace',
    message: `Path escapes Server workspace: ${target}.`,
    details: { cwd: path.resolve(cwd), path: target },
  });
}
