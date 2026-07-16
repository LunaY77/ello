import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentFileSystem } from '@ello/agent';
import { z } from 'zod';

import type { CodingAgentConfig } from '../config/index.js';
import type { DecideApproval } from '../permission/policy.js';

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
 */
export function createSearchTools(
  _config: CodingAgentConfig,
  decide: DecideApproval,
) {
  return [
    defineCodingTool({
      name: 'grep',
      description:
        'Search UTF-8 file contents with a Unicode regular expression. Skips binary files, ignored directories, and files larger than 2 MiB.',
      discovery: {
        aliases: ['search text', 'find content', 'regex'],
        risk: 'readonly',
      },
      input: z
        .object({
          pattern: z.string().min(1),
          path: z.string().default('.'),
          glob: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(500).default(100),
        })
        .strict(),
      approval: (input, ctx) =>
        decide(
          {
            permission: 'search',
            patterns: [input.pattern],
            always: [input.pattern],
            paths: [input.path],
            metadata: {
              kind: 'search',
              pattern: input.pattern,
              path: input.path,
            },
          },
          ctx.agent,
        ),
      execute: async ({ pattern, path: targetPath, glob, limit }, ctx) => {
        const fs = requireFs(ctx.agent);
        const root = resolveRuntimePath(fs, targetPath);
        const output = await searchFiles({
          fs,
          root,
          pattern,
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
      description:
        'Find files using * and ** glob syntax. Does not traverse symlinked directories and ignores .git, node_modules, dist, build, and coverage.',
      discovery: {
        aliases: ['find files', 'match paths', 'files'],
        risk: 'readonly',
      },
      input: z
        .object({
          pattern: z.string().min(1),
          path: z.string().default('.'),
          limit: z.number().int().min(1).max(1000).default(200),
        })
        .strict(),
      approval: (input, ctx) =>
        decide(
          {
            permission: 'search',
            patterns: [input.pattern],
            always: [input.pattern],
            paths: [input.path],
            metadata: {
              kind: 'search',
              pattern: input.pattern,
              path: input.path,
            },
          },
          ctx.agent,
        ),
      execute: async ({ pattern, path: targetPath, limit }, ctx) => {
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
  readonly glob?: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const files = await walk(
    input.fs,
    input.root,
    input.limit * 200,
    input.signal,
  );
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
