import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { defineTool, type AnyAgentTool } from '@ello/agent';
import { z } from 'zod';

import type { CodingAgentConfig } from '../config/index.js';

import { resolveWorkspacePath, truncate, type ApprovalFor } from './shared.js';

const execFileAsync = promisify(execFile);

/**
 * 搜索工具：grep（ripgrep + 回退）/ glob（目录遍历）。
 *
 * 搜索没有现成的环境原语，所以这里保留一份最小的 allowedPaths 解析来确定
 * spawn ripgrep / 遍历的根目录；ripgrep 用 `execFile`（参数数组，注入安全）。
 */
export function createSearchTools(
  config: CodingAgentConfig,
  approval: ApprovalFor,
): AnyAgentTool[] {
  return [
    defineTool({
      name: 'grep',
      description:
        'Search files with ripgrep when available and a Node fallback otherwise.',
      input: z.object({
        pattern: z.string(),
        path: z.string().default('.'),
        glob: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      approval: approval('grep'),
      execute: async ({ pattern, path: targetPath, glob, limit }) => {
        const cwd = resolveWorkspacePath(
          config.cwd,
          config.allowedPaths,
          targetPath,
        );
        try {
          const args = [
            '--line-number',
            '--no-heading',
            '--color',
            'never',
            '--max-count',
            String(limit),
          ];
          if (glob !== undefined) {
            args.push('--glob', glob);
          }
          args.push(pattern, '.');
          const result = await execFileAsync('rg', args, {
            cwd,
            timeout: 15_000,
            maxBuffer: 2 * 1024 * 1024,
          });
          return { matches: truncate(result.stdout) };
        } catch (error) {
          const err = error as {
            stdout?: string;
            stderr?: string;
            code?: number;
          };
          if (err.stdout) {
            return { matches: truncate(err.stdout) };
          }
          // ripgrep exit code 1 = 无匹配（软失败，返回空而非抛错）。
          if (err.code === 1) {
            return { matches: '' };
          }
          throw new Error(err.stderr ?? String(error), { cause: error });
        }
      },
    }),
    defineTool({
      name: 'glob',
      description: 'Find files by a simple glob pattern inside the workspace.',
      input: z.object({
        pattern: z.string(),
        path: z.string().default('.'),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      approval: approval('glob'),
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
        return { matches };
      },
    }),
  ];
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

/** 把简单 glob（`*` / `**`）编译成正则。 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*/gu, '.*')
    .replace(/\*/gu, '[^/]*');
  return new RegExp(`^${escaped}$`, 'u');
}
