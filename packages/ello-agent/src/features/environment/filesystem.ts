/**
 * 环境 feature 提供受路径策略约束的 Agent 文件系统实现。
 *
 * 读取和写入分别在调用时获取路径视图，使授权变化立即影响下一次 I/O。
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { PolicyFileSystem } from './contracts.js';
import { environmentInstructions } from './instructions.js';
import { resolveAllowedTarget } from './paths.js';

/**
 * 创建按读写路径视图执行授权检查的文件系统 adapter。
 *
 * Args:
 * - `cwd`: 当前运行的规范工作目录。
 * - `readPaths`: 每次读操作获取允许根目录的函数。
 * - `writePaths`: 每次写操作获取允许根目录的函数。
 *
 * Returns:
 * - 返回实现 Agent 文件系统协议的策略 adapter。
 */
export function createPolicyFileSystem(
  cwd: string,
  readPaths: () => ReadonlyArray<string>,
  writePaths: () => ReadonlyArray<string>,
): PolicyFileSystem {
  return {
    resolvePath: (targetPath) =>
      resolveAllowedTarget(cwd, targetPath, readPaths()),
    readText: (targetPath) =>
      readFile(resolveAllowedTarget(cwd, targetPath, readPaths()), 'utf8'),
    async writeText(targetPath, content) {
      const resolved = resolveAllowedTarget(cwd, targetPath, writePaths());
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, 'utf8');
    },
    async listDir(targetPath) {
      return (
        await readdir(resolveAllowedTarget(cwd, targetPath, readPaths()))
      ).sort();
    },
    stat: (targetPath) =>
      stat(resolveAllowedTarget(cwd, targetPath, readPaths())),
    getContextInstructions: () =>
      environmentInstructions('file-system', cwd, readPaths()),
  };
}
