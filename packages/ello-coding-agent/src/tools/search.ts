import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { CodingAgentConfig } from '../config/index.js';

import {
  createCodingToolResult,
  defineCodingTool,
} from './runtime/coding-tool.js';
import { resolveWorkspacePath, truncate, type ApprovalFor } from './shared.js';

/**
 * 搜索工具：grep（内容搜索）/ glob（目录遍历）。
 *
 * 搜索没有现成的环境原语，所以这里保留一份最小的 allowedPaths 解析来确定
 * 遍历根目录；实现放在进程内，避免把外部 `rg` 二进制作为运行时依赖。
 */
export function createSearchTools(
  config: CodingAgentConfig,
  _approval: ApprovalFor,
) {
  return [
    defineCodingTool({
      name: 'grep',
      description: 'Search file contents inside the workspace.',
      input: z.object({
        pattern: z.string(),
        path: z.string().default('.'),
        glob: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      execute: async ({ pattern, path: targetPath, glob, limit }) => {
        const cwd = resolveWorkspacePath(
          config.cwd,
          config.allowedPaths,
          targetPath,
        );
        const output = await searchFiles({
          root: cwd,
          pattern,
          ...(glob !== undefined ? { glob } : {}),
          limit,
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
      description: 'Find files by a simple glob pattern inside the workspace.',
      input: z.object({
        pattern: z.string(),
        path: z.string().default('.'),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      execute: async ({ pattern, path: targetPath, limit }) => {
        const cwd = resolveWorkspacePath(
          config.cwd,
          config.allowedPaths,
          targetPath,
        );
        const files = await walk(cwd, limit * 5);
        const matcher = globToRegExp(pattern);
        const matches = files
          .filter((file) => matcher.test(path.relative(cwd, file)))
          .slice(0, limit);
        return createCodingToolResult({
          title: `Glob ${pattern}`,
          output: matches.map((file) => path.relative(cwd, file)).join('\n'),
          metadata: {
            kind: 'search',
            path: targetPath,
            pattern,
            paths: matches.map((file) => path.relative(cwd, file)),
            matchCount: matches.length,
          },
        });
      },
    }),
  ];
}

async function searchFiles(input: {
  readonly root: string;
  readonly pattern: string;
  readonly glob?: string;
  readonly limit: number;
}): Promise<string> {
  const files = await walk(input.root, input.limit * 200);
  const pattern = new RegExp(input.pattern, 'u');
  const fileMatcher =
    input.glob !== undefined ? globToRegExp(input.glob) : undefined;
  const matches: string[] = [];
  for (const file of files) {
    const relativePath = path.relative(input.root, file);
    if (fileMatcher !== undefined && !fileMatcher.test(relativePath)) {
      continue;
    }
    const content = await readSearchableFile(file);
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

async function readSearchableFile(filePath: string): Promise<string | undefined> {
  const content = await readFile(filePath);
  if (content.includes(0)) {
    return undefined;
  }
  return content.toString('utf8');
}

/** 递归遍历目录，跳过 node_modules/.git/dist，最多收集 limit 个文件。 */
async function walk(root: string, limit: number): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (result.length >= limit) {
      return;
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'dist'
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
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

function countLines(value: string): number {
  if (value.trim() === '') {
    return 0;
  }
  return value.split(/\r?\n/u).filter((line) => line.length > 0).length;
}

/** 把简单 glob（`*` / `**`）编译成正则。 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*/gu, '.*')
    .replace(/\*/gu, '[^/]*');
  return new RegExp(`^${escaped}$`, 'u');
}
