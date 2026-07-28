/**
 * 本文件定义搜索后端接口，并提供基于 ripgrep 的本地实现。
 *
 * 搜索后端只负责内容匹配和文件枚举。路径权限检查、上下文行、分页提示和最终输出
 * 仍由搜索工具处理。启动进程时直接传入参数数组，内容搜索只解析 `rg --json` 事件。
 */

import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

const MAX_SEARCH_FILES = 100_000;
const MAX_STDERR_BYTES = 64 * 1024;

export interface SearchProviderMatch {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly lineNumber: number;
}

export interface SearchProviderGrepResult {
  readonly matches: readonly SearchProviderMatch[];
  readonly truncated: boolean;
  readonly nextOffset?: number;
}

export interface SearchProvider {
  /** 搜索匹配内容；当前后端无法处理路径时返回 `null`。 */
  grep(input: {
    readonly root: string;
    readonly file?: string;
    readonly pattern: string;
    readonly glob?: string;
    readonly limit: number;
    readonly offset: number;
    readonly signal?: AbortSignal;
  }): Promise<SearchProviderGrepResult | null>;
  /** 列出候选文件；当前后端无法处理路径时返回 `null`。 */
  listFiles(input: {
    readonly root: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly string[] | null>;
}

/** 创建默认的本地搜索后端。 */
export function createSearchProvider(): SearchProvider {
  return new RipgrepSearchProvider();
}

/** 通过 ripgrep 子进程完成内容搜索和文件枚举。 */
export class RipgrepSearchProvider implements SearchProvider {
  /** 通过 ripgrep 搜索匹配内容。 */
  async grep(
    input: Parameters<SearchProvider['grep']>[0],
  ): Promise<SearchProviderGrepResult | null> {
    if (!(await isLocalPath(input.file ?? input.root))) return null;
    const args = [
      '--json',
      '--stats',
      '--no-config',
      '--hidden',
      '--color',
      'never',
      '--line-number',
      '--max-filesize',
      '2M',
      ...ignoredGlobArguments(),
      ...(input.glob === undefined ? [] : ['--glob', input.glob]),
      '--regexp',
      input.pattern,
      '--',
      input.file === undefined ? '.' : path.relative(input.root, input.file),
    ];
    return await runJsonGrep(args, input);
  }

  /** 通过 ripgrep 列出候选文件。 */
  async listFiles(
    input: Parameters<SearchProvider['listFiles']>[0],
  ): Promise<readonly string[] | null> {
    if (!(await isLocalPath(input.root))) return null;
    return await runFileList(input.root, input.signal);
  }
}

async function runJsonGrep(
  args: readonly string[],
  input: Parameters<SearchProvider['grep']>[0],
): Promise<SearchProviderGrepResult | null> {
  return await new Promise((resolve, reject) => {
    const child = spawn('rg', args, {
      cwd: input.root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const matches: SearchProviderMatch[] = [];
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let stoppedForPage = false;
    let searches: number | undefined;
    let matchIndex = 0;
    let settled = false;
    const abort = () => child.kill('SIGTERM');
    input.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        try {
          const event = parseJsonEvent(line);
          if (event.type === 'match') {
            const currentIndex = matchIndex;
            matchIndex += 1;
            if (currentIndex < input.offset) continue;
            if (matches.length < input.limit) {
              matches.push(readMatch(event, input.root));
            } else {
              truncated = true;
              stoppedForPage = true;
              child.kill('SIGTERM');
            }
          } else if (event.type === 'summary') {
            searches = readSearchCount(event);
          }
        } catch (error) {
          child.kill('SIGTERM');
          finish(undefined, error);
          return;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES) stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === 'ENOENT') finish(null);
      else finish(undefined, error);
    });
    child.on('close', (code, signal) => {
      cleanup();
      if (input.signal?.aborted) {
        finish(undefined, input.signal.reason ?? new Error('Search aborted.'));
        return;
      }
      if (settled) return;
      if (!stoppedForPage && stdout.trim() !== '') {
        try {
          const event = parseJsonEvent(stdout.trim());
          if (event.type === 'match') {
            const currentIndex = matchIndex;
            matchIndex += 1;
            if (currentIndex >= input.offset && matches.length < input.limit) {
              matches.push(readMatch(event, input.root));
            }
          }
          if (event.type === 'summary') searches = readSearchCount(event);
        } catch (error) {
          finish(undefined, error);
          return;
        }
      }
      if (searches !== undefined && searches > MAX_SEARCH_FILES) {
        finish(
          undefined,
          new Error(
            `Search traversal exceeded ${MAX_SEARCH_FILES} files. Narrow filePath and retry so results are complete.`,
          ),
        );
        return;
      }
      if (!stoppedForPage && code !== 0 && code !== 1) {
        finish(
          undefined,
          new Error(
            `Invalid grep regular expression '${input.pattern}' or ripgrep search failed: ${stderr.trim() || `exit ${String(code)} signal ${String(signal)}`}`,
          ),
        );
        return;
      }
      finish({
        matches,
        truncated,
        ...(truncated ? { nextOffset: input.offset + matches.length } : {}),
      });
    });

    function cleanup(): void {
      input.signal?.removeEventListener('abort', abort);
    }
    function finish(
      value: SearchProviderGrepResult | null | undefined,
      error?: unknown,
    ): void {
      if (settled) return;
      settled = true;
      if (error !== undefined) reject(error);
      else resolve(value ?? null);
    }
  });
}

async function runFileList(
  root: string,
  signal?: AbortSignal,
): Promise<readonly string[] | null> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'rg',
      [
        '--files',
        '--null',
        '--no-config',
        '--hidden',
        ...ignoredGlobArguments(),
        '--',
        '.',
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const files: string[] = [];
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      for (;;) {
        const delimiter = stdout.indexOf(0);
        if (delimiter < 0) break;
        const relativePath = stdout.subarray(0, delimiter).toString('utf8');
        stdout = stdout.subarray(delimiter + 1);
        if (relativePath.includes('\uFFFD')) {
          child.kill('SIGTERM');
          reject(new Error('ripgrep returned a non-UTF-8 file path.'));
          return;
        }
        files.push(path.resolve(root, relativePath));
        if (files.length > MAX_SEARCH_FILES) child.kill('SIGTERM');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES) stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === 'ENOENT') finish(null);
      else finish(undefined, error);
    });
    child.on('close', (code) => {
      cleanup();
      if (signal?.aborted) {
        finish(undefined, signal.reason ?? new Error('Search aborted.'));
      } else if (files.length > MAX_SEARCH_FILES) {
        finish(
          undefined,
          new Error(
            `Search traversal exceeded ${MAX_SEARCH_FILES} files. Narrow filePath and retry so results are complete.`,
          ),
        );
      } else if (code !== 0) {
        finish(
          undefined,
          new Error(`ripgrep file listing failed: ${stderr.trim() || code}`),
        );
      } else {
        finish(files);
      }
    });

    function cleanup(): void {
      signal?.removeEventListener('abort', abort);
    }
    function finish(
      value: readonly string[] | null | undefined,
      error?: unknown,
    ): void {
      if (settled) return;
      settled = true;
      if (error !== undefined) reject(error);
      else resolve(value ?? null);
    }
  });
}

function ignoredGlobArguments(): string[] {
  return ['.git', 'node_modules', 'dist', 'build', 'coverage'].flatMap(
    (directory) => ['--glob', `!**/${directory}/**`],
  );
}

async function isLocalPath(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseJsonEvent(line: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) {
      throw new Error('event is not an object');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid ripgrep JSON event: ${line.slice(0, 200)}`, {
      cause: error,
    });
  }
}

function readMatch(
  event: Record<string, unknown>,
  root: string,
): SearchProviderMatch {
  const data = recordField(event, 'data');
  const pathValue = stringField(recordField(data, 'path'), 'text');
  const lineNumber = numberField(data, 'line_number');
  const absolutePath = path.resolve(root, pathValue);
  return {
    absolutePath,
    relativePath: path.relative(root, absolutePath),
    lineNumber,
  };
}

function readSearchCount(event: Record<string, unknown>): number {
  return numberField(
    recordField(recordField(event, 'data'), 'stats'),
    'searches',
  );
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (typeof value !== 'object' || value === null) {
    throw new Error(`ripgrep JSON field '${key}' is not an object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`ripgrep JSON field '${key}' is not a string.`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`ripgrep JSON field '${key}' is not a finite number.`);
  }
  return value;
}
