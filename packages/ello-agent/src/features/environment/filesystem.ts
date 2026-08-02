/**
 * 本地 Environment 文件系统 adapter。
 *
 * 路径只在 Environment 自身路径空间中解析；Handle 关闭后全部操作直接失败。
 */
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import type {
  EnvironmentFileStat,
  EnvironmentFileSystem,
} from './contracts.js';

/**
 * 创建绑定单个 Handle 工作目录的本地文件系统 adapter。
 *
 * Args:
 * - `workingDirectory`: 相对路径的唯一解析基准。
 * - `assertOpen`: 每次 I/O 前校验 Handle generation 仍有效。
 *
 * Returns:
 * - 返回只通过 Environment Path 工作的文件系统能力。
 */
export function createLocalFileSystem(
  workingDirectory: string,
  assertOpen: () => void,
): EnvironmentFileSystem {
  const resolvePath = (targetPath: string): string => {
    assertOpen();
    if (targetPath === '') throw new Error('Environment path is empty.');
    return path.resolve(workingDirectory, targetPath);
  };
  return {
    resolvePath,
    async stat(targetPath) {
      const result = await lstat(resolvePath(targetPath));
      return fileStat(result);
    },
    async readFile(targetPath) {
      return await readFile(resolvePath(targetPath));
    },
    async readText(targetPath) {
      return await readFile(resolvePath(targetPath), 'utf8');
    },
    async writeFile(targetPath, content) {
      const resolved = resolvePath(targetPath);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content);
    },
    async writeText(targetPath, content) {
      const resolved = resolvePath(targetPath);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, 'utf8');
    },
    async listDir(targetPath) {
      return (await readdir(resolvePath(targetPath))).sort((left, right) =>
        left.localeCompare(right),
      );
    },
    async remove(targetPath) {
      const resolved = resolvePath(targetPath);
      const info = await lstat(resolved);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await rmdir(resolved);
      } else {
        await unlink(resolved);
      }
    },
  };
}

function fileStat(
  value: Awaited<ReturnType<typeof lstat>>,
): EnvironmentFileStat {
  return {
    kind: value.isFile()
      ? 'file'
      : value.isDirectory()
        ? 'directory'
        : value.isSymbolicLink()
          ? 'symlink'
          : 'other',
    size: Number(value.size),
    modifiedAtMs: Number(value.mtimeMs),
  };
}
