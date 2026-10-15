/**
 * 本文件定义搜索后端接口，并提供通过 Environment Processes 运行 ripgrep 的实现。
 *
 * 搜索后端只负责内容匹配和文件枚举。路径解释、文件读取、上下文行和分页展示仍由
 * 搜索工具处理；ripgrep 不可用或输出超过有界缓冲时返回 `null` 触发文件系统遍历。
 */
import path from 'node:path';

import type { EnvironmentProcesses } from '../../environment/index.js';

const MAX_SEARCH_FILES = 100_000;
const RIPGREP_TIMEOUT_MS = 30_000;
const RIPGREP_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

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
  /**
   * 通过 Environment 可用的原生搜索程序查找内容。
   *
   * Args:
   * - `input`: Environment Processes、搜索根、pattern、分页和取消信号。
   *
   * Returns:
   * - Promise 兑现为匹配结果；当前 Environment 无法使用原生后端时返回 `null`。
   */
  grep(input: {
    readonly processes: EnvironmentProcesses;
    readonly root: string;
    readonly file?: string;
    readonly pattern: string;
    readonly glob?: string;
    readonly limit: number;
    readonly offset: number;
    readonly signal?: AbortSignal;
  }): Promise<SearchProviderGrepResult | null>;
  /**
   * 通过 Environment 可用的原生搜索程序列出候选文件。
   *
   * Args:
   * - `input`: Environment Processes、搜索根和取消信号。
   *
   * Returns:
   * - Promise 兑现为 Environment Path 集合；无法使用原生后端时返回 `null`。
   */
  listFiles(input: {
    readonly processes: EnvironmentProcesses;
    readonly root: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly string[] | null>;
}

/**
 * 创建通过 Environment Processes 执行 ripgrep 的搜索后端。
 *
 * Args:
 * - 无：实际进程能力随每次搜索输入传入。
 *
 * Returns:
 * - 返回无宿主进程依赖的搜索 provider。
 */
export function createSearchProvider(): SearchProvider {
  return new RipgrepSearchProvider();
}

/** 通过 Environment Processes 完成内容搜索和文件枚举。 */
export class RipgrepSearchProvider implements SearchProvider {
  /**
   * 执行 ripgrep JSON 内容搜索。
   *
   * Args:
   * - `input`: 搜索根、pattern、glob、分页和 Environment Processes。
   *
   * Returns:
   * - Promise 兑现为已分页匹配；缺少 ripgrep 时返回 `null`。
   */
  async grep(
    input: Parameters<SearchProvider['grep']>[0],
  ): Promise<SearchProviderGrepResult | null> {
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
    const execution = await runRipgrep(
      input.processes,
      args,
      input.root,
      input.signal,
    );
    if (execution === null) return null;
    const stdout = outputText(execution.stdout);
    const stderr = outputText(execution.stderr);
    if (stdout === null || stderr === null) return null;
    if (execution.exitCode !== 0 && execution.exitCode !== 1) {
      throw new Error(
        `Invalid grep regular expression '${input.pattern}' or ripgrep search failed: ${stderr.trim() || exitDescription(execution.exitCode, execution.signal)}`,
      );
    }
    const matches: SearchProviderMatch[] = [];
    let searches: number | undefined;
    let matchIndex = 0;
    let truncated = false;
    for (const line of stdout.split('\n')) {
      if (line.trim() === '') continue;
      const event = parseJsonEvent(line);
      if (event.type === 'match') {
        const currentIndex = matchIndex;
        matchIndex += 1;
        if (currentIndex < input.offset) continue;
        if (matches.length < input.limit) {
          matches.push(readMatch(event, input.root));
        } else {
          truncated = true;
        }
      } else if (event.type === 'summary') {
        searches = readSearchCount(event);
      }
    }
    if (searches !== undefined && searches > MAX_SEARCH_FILES) {
      throw traversalLimitError();
    }
    return {
      matches,
      truncated,
      ...(truncated ? { nextOffset: input.offset + matches.length } : {}),
    };
  }

  /**
   * 执行 ripgrep 文件枚举。
   *
   * Args:
   * - `input`: 搜索根、取消信号和 Environment Processes。
   *
   * Returns:
   * - Promise 兑现为 Environment Path 集合；缺少 ripgrep 时返回 `null`。
   */
  async listFiles(
    input: Parameters<SearchProvider['listFiles']>[0],
  ): Promise<readonly string[] | null> {
    const execution = await runRipgrep(
      input.processes,
      [
        '--files',
        '--null',
        '--no-config',
        '--hidden',
        ...ignoredGlobArguments(),
        '--',
        '.',
      ],
      input.root,
      input.signal,
    );
    if (execution === null) return null;
    const stdout = outputBytes(execution.stdout);
    const stderr = outputText(execution.stderr);
    if (stdout === null || stderr === null) return null;
    if (execution.exitCode !== 0) {
      throw new Error(
        `ripgrep file listing failed: ${stderr.trim() || exitDescription(execution.exitCode, execution.signal)}`,
      );
    }
    const files = stdout
      .toString('utf8')
      .split('\0')
      .filter((entry) => entry !== '')
      .map((entry) => {
        if (entry.includes('\uFFFD')) {
          throw new Error('ripgrep returned a non-UTF-8 file path.');
        }
        return path.resolve(input.root, entry);
      });
    if (files.length > MAX_SEARCH_FILES) throw traversalLimitError();
    return files;
  }
}

async function runRipgrep(
  processes: EnvironmentProcesses,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
) {
  try {
    const result = await processes.exec({
      command: 'rg',
      args,
      cwd,
      maxRuntimeMs: RIPGREP_TIMEOUT_MS,
      outputLimitBytes: RIPGREP_OUTPUT_LIMIT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      result.exitCode === 127 ||
      Buffer.from(result.stderr.data).toString('utf8').includes('rg: not found')
    ) {
      return null;
    }
    return result;
  } catch (error) {
    if (isMissingExecutable(error)) return null;
    throw error;
  }
}

function outputBytes(
  output: Awaited<ReturnType<EnvironmentProcesses['exec']>>['stdout'],
): Buffer | null {
  return output.truncatedBytes === 0 ? Buffer.from(output.data) : null;
}

function outputText(
  output: Awaited<ReturnType<EnvironmentProcesses['exec']>>['stdout'],
): string | null {
  return output.truncatedBytes === 0
    ? Buffer.from(output.data).toString('utf8')
    : null;
}

function ignoredGlobArguments(): string[] {
  return ['.git', 'node_modules', 'dist', 'build', 'coverage'].flatMap(
    (directory) => ['--glob', `!**/${directory}/**`],
  );
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

function traversalLimitError(): Error {
  return new Error(
    `Search traversal exceeded ${MAX_SEARCH_FILES} files. Narrow filePath and retry so results are complete.`,
  );
}

function exitDescription(
  exitCode: number | null,
  signal: string | null,
): string {
  return exitCode === null
    ? `signal ${signal ?? 'unknown'}`
    : `exit ${exitCode}`;
}

function isMissingExecutable(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
