import { exec } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cwd as processCwd } from 'node:process';
import { promisify } from 'node:util';

import type { AgentEnvironment } from '../public/types.js';

const execAsync = promisify(exec);

export interface CreateLocalEnvironmentOptions {
  readonly cwd?: string;
  readonly allowedPaths?: string[];
}

/**
 * 创建本地文件系统与 shell 环境。
 *
 * Args:
 *   options.cwd: 相对路径解析和 shell 默认执行的工作目录。
 *   options.allowedPaths: 文件系统工具允许访问的根路径；未传入时只允许 cwd。
 *
 * Returns:
 *   AgentEnvironment，包含 files、shell 和 getInstructions()。
 *
 * @example
 * ```ts
 * const env = createLocalEnvironment({
 *   cwd: process.cwd(),
 *   allowedPaths: [process.cwd()],
 * });
 * ```
 */
export function createLocalEnvironment(
  options: CreateLocalEnvironmentOptions = {},
): AgentEnvironment {
  const cwd = path.resolve(options.cwd ?? processCwd());
  const allowedPaths = (options.allowedPaths?.length ? options.allowedPaths : [cwd]).map(
    (item) => path.resolve(cwd, item),
  );
  return {
    files: {
      readText: (targetPath) => readFile(resolveAllowedPath(cwd, allowedPaths, targetPath), 'utf8'),
      async writeText(targetPath, content) {
        const resolved = resolveAllowedPath(cwd, allowedPaths, targetPath);
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, content, 'utf8');
      },
      async listDir(targetPath) {
        return (await readdir(resolveAllowedPath(cwd, allowedPaths, targetPath))).sort();
      },
    },
    shell: {
      async run(command, runOptions = {}) {
        try {
          const result = await execAsync(command, {
            cwd: runOptions.cwd ?? cwd,
            timeout: runOptions.timeout,
          });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const err = error as NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
            code?: number | string;
            killed?: boolean;
          };
          return {
            exitCode: err.killed ? -1 : typeof err.code === 'number' ? err.code : 1,
            stdout: err.stdout ?? '',
            stderr: err.killed ? 'timeout' : (err.stderr ?? err.message),
          };
        }
      },
    },
    getInstructions() {
      return `<environment-context>\n  <working-directory>${cwd}</working-directory>\n</environment-context>`;
    },
  };
}

function resolveAllowedPath(
  cwd: string,
  allowedPaths: readonly string[],
  targetPath: string,
): string {
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(cwd, targetPath);
  const allowed = allowedPaths.some((allowedPath) => {
    const relative = path.relative(allowedPath, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!allowed) {
    throw new Error(`Path not allowed: ${resolved}`);
  }
  return resolved;
}
