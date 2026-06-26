import { exec } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cwd as processCwd } from 'node:process';
import { promisify } from 'node:util';

import {
  Environment,
  type FileOperator,
  type Shell,
  type ShellResult,
} from './base.js';

const execAsync = promisify(exec);

/**
 * 基于本地文件系统的 FileOperator 实现。
 *
 * Args:
 *   defaultPath: 默认工作目录, 相对路径基于此解析。
 *   allowedPaths: 允许访问的路径列表; 未传入时默认为 [defaultPath]。
 */
export class LocalFileOperator implements FileOperator {
  private readonly defaultPath: string;
  private readonly allowedPaths: string[];

  constructor(defaultPath: string, allowedPaths?: string[]) {
    this.defaultPath = path.resolve(defaultPath);
    this.allowedPaths = (
      allowedPaths?.length ? allowedPaths : [this.defaultPath]
    ).map((item) => path.resolve(item));
  }

  /**
   * 将路径解析为绝对路径。
   */
  private resolvePath(targetPath: string): string {
    const resolved = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.defaultPath, targetPath);
    this.checkAllowed(resolved);
    return resolved;
  }

  /**
   * 校验路径是否在允许列表中。
   */
  private checkAllowed(resolved: string): void {
    const allowed = this.allowedPaths.some((allowedPath) => {
      const relative = path.relative(allowedPath, resolved);
      return (
        relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative))
      );
    });
    if (!allowed) {
      throw new Error(`Path not allowed: ${resolved}`);
    }
  }

  async readText(targetPath: string): Promise<string> {
    return readFile(this.resolvePath(targetPath), 'utf8');
  }

  async writeText(targetPath: string, content: string): Promise<void> {
    const resolved = this.resolvePath(targetPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, 'utf8');
  }

  async listDir(targetPath: string): Promise<string[]> {
    const entries = await readdir(this.resolvePath(targetPath));
    return entries.sort();
  }
}

/**
 * 基于 child_process.exec 的本地 Shell 实现。
 *
 * Args:
 *   defaultCwd: 默认工作目录; 未传入时使用进程当前目录。
 */
export class LocalShell implements Shell {
  constructor(private readonly defaultCwd: string | null = null) {}

  async run(
    command: string,
    options: { cwd?: string; timeout?: number } = {},
  ): Promise<ShellResult> {
    try {
      const result = await execAsync(command, {
        cwd: options.cwd ?? this.defaultCwd ?? undefined,
        timeout: options.timeout,
      });
      return {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
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
  }
}

/**
 * 本地环境, 提供本地文件系统和 shell 访问。
 *
 * Args:
 *   defaultPath: 工作目录; 未传入时使用 process.cwd()。
 *   allowedPaths: 文件操作允许的路径列表; 未传入时仅允许 defaultPath。
 */
export class LocalEnvironment extends Environment {
  private readonly defaultPath: string;
  private readonly allowedPaths: string[] | undefined;

  constructor(options: { defaultPath?: string; allowedPaths?: string[] } = {}) {
    super();
    this.defaultPath = path.resolve(options.defaultPath ?? processCwd());
    this.allowedPaths = options.allowedPaths;
  }

  protected async setup(): Promise<void> {
    this.fileOperatorValue = new LocalFileOperator(
      this.defaultPath,
      this.allowedPaths,
    );
    this.shellValue = new LocalShell(this.defaultPath);
  }

  protected async teardown(): Promise<void> {
    return Promise.resolve();
  }

  async getContextInstructions(): Promise<string> {
    if (!this.entered) {
      throw new Error('Environment has not been entered.');
    }
    return `<environment-context>\n  <working-directory>${this.defaultPath}</working-directory>\n</environment-context>`;
  }
}
