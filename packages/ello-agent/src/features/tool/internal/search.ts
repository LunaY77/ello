/**
 * 本文件负责 tool feature 的“search”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import path from 'node:path';

import { z } from 'zod';

import {
  cliInput,
  commandInput,
  defineCommand,
  type CommandContext,
} from '../../command/index.js';
import type { CodingAgentConfig } from '../../config/index.js';
import type { EnvironmentFileSystem } from '../../environment/index.js';
import type { DecideApproval } from '../permissions/policy.js';

import { createCommandResult } from './runtime/command-result.js';
import {
  createSearchProvider,
  type SearchProvider,
  type SearchProviderMatch,
} from './search-provider.js';
import {
  requireFs,
  requireProcesses,
  resolveRuntimePath,
  statRuntimePath,
} from './shared.js';

const MAX_SEARCH_FILES = 100_000;

/**
 * 搜索工具：grep（内容搜索）/ glob（目录遍历）。
 *
 * 遍历和读取通过 runtime fileSystem 完成，确保 external_directory 审批后的
 * 执行边界与 read/write 工具一致。
 *
 * Args:
 * - `_config`: `createSearchTools` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `decide`: `createSearchTools` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `createSearchTools` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `search` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createSearchCommands(
  _config: CodingAgentConfig,
  decide: DecideApproval,
  provider: SearchProvider = createSearchProvider(),
) {
  const grepInput = z
    .object({
      pattern: z
        .string()
        .min(1)
        .describe('Regular expression pattern to search for'),
      filePath: z
        .string()
        .default('.')
        .describe('File or directory to search in'),
      glob: z
        .string()
        .min(1)
        .optional()
        .describe('Glob filtering paths relative to the search root'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe('Maximum number of matching lines'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Matching lines to skip for pagination'),
      context: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(0)
        .describe('Context lines before and after each match'),
    })
    .strict();
  const globInput = z
    .object({
      pattern: z
        .string()
        .min(1)
        .describe("Glob matched against the whole path, e.g. '**/*.ts'"),
      filePath: z.string().default('.').describe('Directory to search in'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(200)
        .describe('Maximum number of results'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Sorted matching paths to skip'),
    })
    .strict();
  const executeTextSearch = async (
    {
      pattern,
      filePath: targetPath,
      glob,
      limit,
      offset,
      context,
    }: z.infer<typeof grepInput>,
    ctx: CommandContext,
  ) => {
    const fs = requireFs(ctx);
    const resolved = resolveRuntimePath(fs, targetPath);
    const info = await statRuntimePath(fs, targetPath);
    // 单文件搜索以其所在目录为 root，输出仍是相对路径形式的 'path:line:text'。
    const root = info.kind === 'directory' ? resolved : path.dirname(resolved);
    const result = await searchFiles({
      fs,
      processes: requireProcesses(ctx),
      provider,
      root,
      pattern,
      ...(info.kind === 'directory' ? {} : { file: resolved }),
      ...(glob !== undefined ? { glob } : {}),
      limit,
      offset,
      context,
      signal: ctx.signal,
    });
    return createCommandResult({
      title: `Search ${pattern}`,
      output: result.output,
      metadata: {
        kind: 'search',
        summary: `grep ${pattern}`,
        path: targetPath,
        pattern,
        glob,
        matchCount: result.matchCount,
        offset,
        context,
        truncated: result.truncated,
        ...(result.nextOffset === undefined
          ? {}
          : { nextOffset: result.nextOffset }),
      },
    });
  };
  const executeFileSearch = async (
    { pattern, filePath: targetPath, limit, offset }: z.infer<typeof globInput>,
    ctx: CommandContext,
  ) => {
    const fs = requireFs(ctx);
    const root = resolveRuntimePath(fs, targetPath);
    const files =
      (await provider.listFiles({
        processes: requireProcesses(ctx),
        root,
        signal: ctx.signal,
      })) ?? (await walkAllSearchFiles(fs, root, ctx.signal));
    const matcher = globToRegExp(pattern);
    const allMatches = files
      .filter((file) => matcher.test(path.relative(root, file)))
      .sort((left, right) => left.localeCompare(right));
    const matches = allMatches.slice(offset, offset + limit);
    const truncated = offset + matches.length < allMatches.length;
    const nextOffset = truncated ? offset + matches.length : undefined;
    const rendered = matches.map((file) => path.relative(root, file));
    if (nextOffset !== undefined) {
      rendered.push(`[More paths available. Retry with offset ${nextOffset}.]`);
    }
    return createCommandResult({
      title: `Glob ${pattern}`,
      output: rendered.join('\n'),
      metadata: {
        kind: 'search',
        path: targetPath,
        pattern,
        paths: matches.map((file) => path.relative(root, file)),
        matchCount: matches.length,
        offset,
        truncated,
        ...(nextOffset === undefined ? {} : { nextOffset }),
      },
    });
  };
  const searchInput = z
    .object({
      kind: z.enum(['text', 'files']).describe('Search contents or paths'),
      pattern: z.string().min(1).describe('Regular expression or glob pattern'),
      filePath: z.string().default('.').describe('Search root or file'),
      glob: z
        .string()
        .min(1)
        .optional()
        .describe('Optional content-search path filter'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('Result limit'),
      offset: z.number().int().min(0).default(0).describe('Result offset'),
      context: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(0)
        .describe('Context lines for text search'),
    })
    .strict();
  const searchCommand = defineCommand({
    name: 'search',
    summary: 'Search file contents or file paths.',
    details:
      "Use kind 'text' for a Unicode regular expression inside files and kind 'files' for a glob matched against paths.",
    examples: [
      {
        description: 'Search text under a directory',
        frame: {
          args: ['text', 'TODO', '--file-path', '.'],
        },
      },
    ],
    aliases: ['find', 'grep', 'glob'],
    risk: 'readonly',
    invocation: cliInput(commandInput(searchInput), {
      positionals: [{ field: 'kind' }, { field: 'pattern' }],
      options: ['filePath', 'glob', 'limit', 'offset', 'context'],
    }),
    effects: {
      concurrencySafe: true,
      readOnly: true,
      destructive: false,
      interruptible: true,
      telemetryTag: 'search',
    },
    approval: (input, ctx) =>
      decide(
        {
          permission: 'search',
          patterns: [input.pattern],
          always: [input.pattern],
          paths: [input.filePath],
          metadata: {
            kind: 'search',
            pattern: input.pattern,
            path: input.filePath,
          },
        },
        ctx,
      ),
    execution: {
      kind: 'immediate',
      run: async (input, ctx) => {
        if (input.kind === 'files') {
          if (input.glob !== undefined || input.context !== 0) {
            throw new Error(
              '--glob and --context are only valid for search text',
            );
          }
          return executeFileSearch(
            globInput.parse({
              pattern: input.pattern,
              filePath: input.filePath,
              limit: input.limit ?? 200,
              offset: input.offset,
            }),
            ctx,
          );
        }
        return executeTextSearch(
          grepInput.parse({
            pattern: input.pattern,
            filePath: input.filePath,
            ...(input.glob === undefined ? {} : { glob: input.glob }),
            limit: input.limit ?? 100,
            offset: input.offset,
            context: input.context,
          }),
          ctx,
        );
      },
    },
  });
  return [searchCommand];
}

async function searchFiles(input: {
  readonly fs: EnvironmentFileSystem;
  readonly processes: ReturnType<typeof requireProcesses>;
  readonly provider: SearchProvider;
  readonly root: string;
  readonly pattern: string;
  /** 显式单文件目标；给出时跳过目录遍历，只搜索该文件。 */
  readonly file?: string;
  readonly glob?: string;
  readonly limit: number;
  readonly offset: number;
  readonly context: number;
  readonly signal?: AbortSignal;
}): Promise<SearchFilesResult> {
  const native = await input.provider.grep({
    processes: input.processes,
    root: input.root,
    ...(input.file === undefined ? {} : { file: input.file }),
    pattern: input.pattern,
    ...(input.glob === undefined ? {} : { glob: input.glob }),
    limit: input.limit,
    offset: input.offset,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (native !== null) {
    const matches = await hydrateProviderMatches(input.fs, native.matches);
    return renderSelectedSearchMatches(
      matches,
      input.context,
      native.truncated,
      native.nextOffset,
    );
  }
  const files =
    input.file === undefined
      ? await walkAllSearchFiles(input.fs, input.root, input.signal)
      : [input.file];
  let pattern: RegExp;
  try {
    pattern = new RegExp(input.pattern, 'u');
  } catch (error) {
    throw new Error(
      `Invalid grep regular expression '${input.pattern}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const fileMatcher =
    input.glob !== undefined ? globToRegExp(input.glob) : undefined;
  const matches: SearchMatch[] = [];
  const requiredMatches = input.offset + input.limit + 1;
  for (const file of files) {
    input.signal?.throwIfAborted();
    const relativePath = path.relative(input.root, file);
    if (fileMatcher !== undefined && !fileMatcher.test(relativePath)) {
      continue;
    }
    const content = await readSearchableFile(input.fs, file);
    if (content === undefined) {
      continue;
    }
    const lines = content.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (pattern.test(line)) {
        matches.push({ relativePath, lineIndex: index, lines });
        if (matches.length >= requiredMatches) {
          return renderSearchMatches(matches, input);
        }
      }
    }
  }
  return renderSearchMatches(matches, input);
}

interface SearchMatch {
  readonly relativePath: string;
  readonly lineIndex: number;
  readonly lines: readonly string[];
}

interface SearchFilesResult {
  readonly output: string;
  readonly matchCount: number;
  readonly truncated: boolean;
  readonly nextOffset?: number;
}

function renderSearchMatches(
  matches: readonly SearchMatch[],
  input: Pick<
    Parameters<typeof searchFiles>[0],
    'offset' | 'limit' | 'context'
  >,
): SearchFilesResult {
  const selected = matches.slice(input.offset, input.offset + input.limit);
  const truncated = input.offset + selected.length < matches.length;
  const nextOffset = truncated ? input.offset + selected.length : undefined;
  return renderSelectedSearchMatches(
    selected,
    input.context,
    truncated,
    nextOffset,
  );
}

function renderSelectedSearchMatches(
  selected: readonly SearchMatch[],
  context: number,
  truncated: boolean,
  nextOffset: number | undefined,
): SearchFilesResult {
  const output: string[] = [];
  for (const [relativePath, fileMatches] of groupMatchesByFile(selected)) {
    const lines = fileMatches[0]?.lines;
    if (lines === undefined) continue;
    const matchingLines = new Set(fileMatches.map((match) => match.lineIndex));
    const ranges = mergeLineRanges(
      fileMatches.map((match) => ({
        start: Math.max(0, match.lineIndex - context),
        end: Math.min(lines.length - 1, match.lineIndex + context),
      })),
    );
    for (const [rangeIndex, range] of ranges.entries()) {
      if (output.length > 0 && rangeIndex > 0) output.push('--');
      for (
        let lineIndex = range.start;
        lineIndex <= range.end;
        lineIndex += 1
      ) {
        const line = lines[lineIndex];
        if (line === undefined) continue;
        const separator = matchingLines.has(lineIndex) ? ':' : '-';
        output.push(
          `${relativePath}${separator}${lineIndex + 1}${separator}${line}`,
        );
      }
    }
  }
  if (nextOffset !== undefined) {
    output.push(`[More matches available. Retry with offset ${nextOffset}.]`);
  }
  return {
    output: output.join('\n'),
    matchCount: selected.length,
    truncated,
    ...(nextOffset === undefined ? {} : { nextOffset }),
  };
}

async function hydrateProviderMatches(
  fs: EnvironmentFileSystem,
  matches: readonly SearchProviderMatch[],
): Promise<SearchMatch[]> {
  const contents = new Map<string, readonly string[]>();
  const hydrated: SearchMatch[] = [];
  for (const match of matches) {
    let lines = contents.get(match.absolutePath);
    if (lines === undefined) {
      const content = await readSearchableFile(fs, match.absolutePath);
      if (content === undefined) continue;
      lines = content.split(/\r?\n/u);
      contents.set(match.absolutePath, lines);
    }
    const lineIndex = match.lineNumber - 1;
    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(
        `ripgrep returned out-of-range line ${match.lineNumber} for ${match.relativePath}.`,
      );
    }
    hydrated.push({ relativePath: match.relativePath, lineIndex, lines });
  }
  return hydrated;
}

function groupMatchesByFile(
  matches: readonly SearchMatch[],
): ReadonlyMap<string, readonly SearchMatch[]> {
  const grouped = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const current = grouped.get(match.relativePath) ?? [];
    current.push(match);
    grouped.set(match.relativePath, current);
  }
  return grouped;
}

function mergeLineRanges(
  ranges: readonly { readonly start: number; readonly end: number }[],
): readonly { readonly start: number; readonly end: number }[] {
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

async function readSearchableFile(
  fs: EnvironmentFileSystem,
  filePath: string,
): Promise<string | undefined> {
  const info = await fs.stat(filePath);
  if (info.size > 2 * 1024 * 1024) {
    return undefined;
  }
  const content = await fs.readText(filePath);
  if (content.includes('\u0000') || content.includes('\uFFFD')) {
    return undefined;
  }
  return content;
}

/** 递归遍历目录，跳过 node_modules/.git/dist，最多收集 limit 个文件。 */
async function walk(
  fs: EnvironmentFileSystem,
  root: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    signal?.throwIfAborted();
    if (result.length >= limit) {
      return;
    }
    const entries = await fs.listDir(dir);
    entries.sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry)) {
        continue;
      }
      const fullPath = path.join(dir, entry);
      const info = await statRuntimePath(fs, fullPath);
      if (info.kind === 'symlink') {
        continue;
      }
      if (info.kind === 'directory') {
        await visit(fullPath);
      } else {
        result.push(fullPath);
      }
      if (result.length >= limit) {
        return;
      }
    }
  }
  await visit(root);
  return result;
}

async function walkAllSearchFiles(
  fs: EnvironmentFileSystem,
  root: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const files = await walk(fs, root, MAX_SEARCH_FILES + 1, signal);
  if (files.length > MAX_SEARCH_FILES) {
    throw new Error(
      `Search traversal exceeded ${MAX_SEARCH_FILES} files. Narrow filePath and retry so results are complete.`,
    );
  }
  return files;
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

/** 把简单 glob（`*` / `**`）编译成正则。 */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
      continue;
    }
    if (character === '*') {
      source += '[^/]*';
      continue;
    }
    source += /[.+^${}()|[\]\\]/u.test(character ?? '')
      ? `\\${character}`
      : character;
  }
  return new RegExp(`^${source}$`, 'u');
}
