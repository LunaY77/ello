/**
 * 本文件负责 tool feature 的“search”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { AgentFileSystem } from '../../agent/engine/index.js';
import type { CodingAgentConfig } from '../../config/index.js';
import type { DecideApproval } from '../permissions/policy.js';

import {
  createCodingToolResult,
  defineCodingTool,
} from './runtime/coding-tool.js';
import {
  requireFs,
  resolveRuntimePath,
  statRuntimePath,
  truncate,
} from './shared.js';

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
export function createSearchTools(
  _config: CodingAgentConfig,
  decide: DecideApproval,
) {
  return [
    defineCodingTool({
      name: 'grep',
      // 无副作用只读工具：允许与同批其他只读调用并发执行。
      concurrency: 'parallel',
      description: `Search UTF-8 file contents with a Unicode regular expression and return 'path:line:text' for every match.
'filePath' accepts either a directory or a single file: a directory is walked recursively, a file is searched on its own so you can scan one known file without inventing a glob. 'glob' filters candidate paths relative to the search root. 'limit' caps the number of returned match lines; hitting the cap stops the walk, so raise it or narrow 'filePath' when results look cut off.
The pattern is a JavaScript RegExp with the 'u' flag, matched per line, case sensitive; an invalid pattern fails the call instead of returning nothing. Binary files, files above 2 MiB, symlinked directories, and .git/node_modules/dist/build/coverage are skipped, so a file inside them is only searched when named directly. No match is a success with empty output, not an error.
Use grep to find where text occurs; use glob to find paths by name without reading contents; use read once you know the file and want surrounding lines.`,
      discovery: {
        aliases: ['search text', 'find content', 'regex'],
        risk: 'readonly',
      },
      input: z
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
            .describe(
              'Glob pattern filtering candidate paths relative to the search root',
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .default(100)
            .describe('Maximum number of results'),
        })
        .strict(),
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
          ctx.agent,
        ),
      execute: async ({ pattern, filePath: targetPath, glob, limit }, ctx) => {
        const fs = requireFs(ctx.agent);
        const resolved = resolveRuntimePath(fs, targetPath);
        const info = await statRuntimePath(fs, targetPath);
        // 单文件搜索以其所在目录为 root，输出仍是相对路径形式的 'path:line:text'。
        const root = info.isDirectory() ? resolved : path.dirname(resolved);
        const output = await searchFiles({
          fs,
          root,
          pattern,
          ...(info.isDirectory() ? {} : { file: resolved }),
          ...(glob !== undefined ? { glob } : {}),
          limit,
          ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
        });
        return createCodingToolResult({
          title: `Search ${pattern}`,
          output: truncate(output),
          metadata: {
            kind: 'search',
            summary: `grep ${pattern}`,
            path: targetPath,
            pattern,
            glob,
            matchCount: countLines(output),
          },
        });
      },
    }),
    defineCodingTool({
      name: 'glob',
      // 无副作用只读工具：允许与同批其他只读调用并发执行。
      concurrency: 'parallel',
      description: `Find files by path shape and return paths relative to 'filePath', sorted lexicographically.
'pattern' must match the whole relative path: '*' matches within one segment, '**/' matches any number of leading directories, so use '**/*.ts' rather than '*.ts' to reach nested files. Only files are returned, never directories. 'filePath' must be a directory; pass a file path to read or grep instead. 'limit' caps returned paths after sorting, so the result stays the lexicographic prefix of all matches.
Symlinked directories are not traversed and .git, node_modules, dist, build, and coverage are ignored, so build artifacts and dependencies never appear. No match is a success with empty output.
Use glob when you know part of a name or extension; use grep when you know text inside the file; use read on a directory path for a single non-recursive listing with sizes.`,
      discovery: {
        aliases: ['find files', 'match paths', 'files'],
        risk: 'readonly',
      },
      input: z
        .object({
          pattern: z
            .string()
            .min(1)
            .describe(
              "Glob pattern matched against the whole relative path, e.g. '**/*.ts'",
            ),
          filePath: z
            .string()
            .default('.')
            .describe('Directory to search in'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .default(200)
            .describe('Maximum number of results'),
        })
        .strict(),
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
          ctx.agent,
        ),
      execute: async ({ pattern, filePath: targetPath, limit }, ctx) => {
        const fs = requireFs(ctx.agent);
        const root = resolveRuntimePath(fs, targetPath);
        const files = await walk(fs, root, 100_000, ctx.abortSignal);
        const matcher = globToRegExp(pattern);
        const matches = files
          .filter((file) => matcher.test(path.relative(root, file)))
          .sort((left, right) => left.localeCompare(right))
          .slice(0, limit);
        return createCodingToolResult({
          title: `Glob ${pattern}`,
          output: matches.map((file) => path.relative(root, file)).join('\n'),
          metadata: {
            kind: 'search',
            path: targetPath,
            pattern,
            paths: matches.map((file) => path.relative(root, file)),
            matchCount: matches.length,
          },
        });
      },
    }),
  ];
}

async function searchFiles(input: {
  readonly fs: AgentFileSystem;
  readonly root: string;
  readonly pattern: string;
  /** 显式单文件目标；给出时跳过目录遍历，只搜索该文件。 */
  readonly file?: string;
  readonly glob?: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const files =
    input.file === undefined
      ? await walk(input.fs, input.root, input.limit * 200, input.signal)
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
  const matches: string[] = [];
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
        matches.push(`${relativePath}:${index + 1}:${line}`);
        if (matches.length >= input.limit) {
          return matches.join('\n');
        }
      }
    }
  }
  return matches.join('\n');
}

async function readSearchableFile(
  fs: AgentFileSystem,
  filePath: string,
): Promise<string | undefined> {
  const info = await stat(filePath);
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
  fs: AgentFileSystem,
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
      const linkInfo = await lstat(fullPath);
      if (linkInfo.isSymbolicLink()) {
        continue;
      }
      const info = await statRuntimePath(fs, fullPath);
      if (info.isDirectory()) {
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

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

function countLines(value: string): number {
  if (value.trim() === '') {
    return 0;
  }
  return value.split(/\r?\n/u).filter((line) => line.length > 0).length;
}

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
