import { copyFile, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { defineTool } from '../public/tool.js';
import type { AgentTool } from '../public/types.js';

/**
 * 创建文件系统工具。
 *
 * 包含 read_file、list_dir、write_file、edit_file、glob、grep、mkdir、
 * delete_file、move_copy。工具通过 AgentEnvironment.files 访问文件；
 * 少量递归搜索工具直接使用 Node fs。
 *
 * Returns:
 *   AgentTool[]，可直接传给 createAgent({ tools })。
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   model,
 *   environment: createLocalEnvironment({ cwd }),
 *   tools: createFilesystemTools(),
 * });
 * ```
 */
export function createFilesystemTools(): AgentTool<any, unknown>[] {
  return [
    defineTool({
      name: 'read_file',
      description: 'Read a UTF-8 file from the agent environment.',
      input: z.object({ path: z.string() }),
      execute: async ({ path }, ctx) => ctx.environment.files?.readText(path) ?? '',
    }),
    defineTool({
      name: 'list_dir',
      description: 'List directory entries from the agent environment.',
      input: z.object({ path: z.string().default('.') }),
      execute: async ({ path }, ctx) => ctx.environment.files?.listDir(path) ?? [],
    }),
    defineTool({
      name: 'write_file',
      description: 'Write UTF-8 content to a file.',
      input: z.object({ path: z.string(), content: z.string() }),
      approval: () => 'required',
      execute: async ({ path, content }, ctx) => {
        await ctx.environment.files?.writeText(path, content);
        return `wrote ${path}`;
      },
    }),
    defineTool({
      name: 'edit_file',
      description: 'Replace text in a UTF-8 file.',
      input: z.object({
        path: z.string(),
        oldString: z.string(),
        newString: z.string(),
        replaceAll: z.boolean().default(false),
      }),
      approval: () => 'required',
      execute: async ({ path: targetPath, oldString, newString, replaceAll }, ctx) => {
        const current = (await ctx.environment.files?.readText(targetPath)) ?? '';
        const occurrences = current.split(oldString).length - 1;
        if (occurrences === 0) {
          throw new Error(`Text not found in ${targetPath}.`);
        }
        if (!replaceAll && occurrences > 1) {
          throw new Error(`Text is not unique in ${targetPath}.`);
        }
        const next = replaceAll
          ? current.split(oldString).join(newString)
          : current.replace(oldString, newString);
        await ctx.environment.files?.writeText(targetPath, next);
        return `edited ${targetPath}`;
      },
    }),
    defineTool({
      name: 'glob',
      description: 'Find files under a directory by substring pattern.',
      input: z.object({
        path: z.string().default('.'),
        pattern: z.string(),
        maxResults: z.number().int().positive().default(100),
      }),
      execute: async ({ path: rootPath, pattern, maxResults }) => {
        const results: string[] = [];
        await walk(rootPath, pattern, results, maxResults);
        return results;
      },
    }),
    defineTool({
      name: 'grep',
      description: 'Search text files under a directory.',
      input: z.object({
        path: z.string().default('.'),
        pattern: z.string(),
        maxResults: z.number().int().positive().default(100),
      }),
      execute: async ({ path: rootPath, pattern, maxResults }) => {
        const files: string[] = [];
        await walk(rootPath, '', files, maxResults * 4);
        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const file of files) {
          if (matches.length >= maxResults) {
            break;
          }
          try {
            const content = await readFile(file, 'utf8');
            content.split('\n').forEach((line, index) => {
              if (matches.length < maxResults && line.includes(pattern)) {
                matches.push({ path: file, line: index + 1, text: line });
              }
            });
          } catch {
            // 忽略二进制或不可读文件。
          }
        }
        return matches;
      },
    }),
    defineTool({
      name: 'mkdir',
      description: 'Create a directory recursively.',
      input: z.object({ path: z.string() }),
      approval: () => 'required',
      execute: async ({ path: targetPath }) => {
        await mkdir(targetPath, { recursive: true });
        return `created ${targetPath}`;
      },
    }),
    defineTool({
      name: 'delete_file',
      description: 'Delete a file or directory.',
      input: z.object({ path: z.string(), recursive: z.boolean().default(false) }),
      approval: () => 'required',
      execute: async ({ path: targetPath, recursive }) => {
        await rm(targetPath, { recursive, force: true });
        return `deleted ${targetPath}`;
      },
    }),
    defineTool({
      name: 'move_copy',
      description: 'Move or copy a file.',
      input: z.object({
        source: z.string(),
        destination: z.string(),
        copy: z.boolean().default(false),
      }),
      approval: () => 'required',
      execute: async ({ source, destination, copy }) => {
        await mkdir(path.dirname(destination), { recursive: true });
        if (copy) {
          await copyFile(source, destination);
        } else {
          await rename(source, destination);
        }
        return `${copy ? 'copied' : 'moved'} ${source} to ${destination}`;
      },
    }),
  ];
}

async function walk(
  rootPath: string,
  pattern: string,
  results: string[],
  maxResults: number,
): Promise<void> {
  if (results.length >= maxResults) {
    return;
  }
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, pattern, results, maxResults);
    } else if (pattern === '' || fullPath.includes(pattern)) {
      results.push(fullPath);
      if (results.length >= maxResults) {
        return;
      }
    }
  }
}
