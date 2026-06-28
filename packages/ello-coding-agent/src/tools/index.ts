import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { defineTool, type AnyAgentTool } from '@ello/agent';
import { z } from 'zod';

import type { CodingAgentConfig } from '../config.js';
import { applyPermissionPolicy, type PermissionRule } from '../permissions.js';

const execFileAsync = promisify(execFile);

/** 工具输出最大字符数，避免单个 tool result 撑爆上下文和 TUI。 */
const MAX_TOOL_OUTPUT = 12_000;

/** 默认 coding 工具的构造参数。 */
export interface CreateCodingToolsOptions {
  readonly config: CodingAgentConfig;
  readonly denied?: ReadonlyMap<string, number>;
  readonly rules?: () => readonly PermissionRule[];
}

/**
 * 创建 coding-agent 默认工具集。
 *
 * 每个工具都在 product 层定义 schema、permission classifier 和结果截断；
 * @ello/agent 只负责执行调度和事件流，不理解具体 coding 业务。
 */
export function createCodingTools(options: CreateCodingToolsOptions): AnyAgentTool[] {
  const { config } = options;
  const approval = <TInput>(toolName: string) => (input: TInput) =>
    applyPermissionPolicy({
      toolName,
      input,
      cwd: config.cwd,
      allowedPaths: config.allowedPaths,
      mode: config.approvalMode,
      rules: [...config.permissionRules, ...(options.rules?.() ?? [])],
      ...(options.denied !== undefined ? { repeatedDenials: options.denied } : {}),
    });

  return [
    defineTool({
      name: 'read',
      description: 'Read a UTF-8 text file with optional offset and limit. Output includes line numbers.',
      input: z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(2000).optional() }),
      approval: approval('read'),
      execute: async ({ path: targetPath, offset = 1, limit = 400 }) => {
        const resolved = resolveWorkspacePath(config, targetPath);
        const text = await readFile(resolved, 'utf8');
        const lines = text.split(/\r?\n/);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        return {
          path: targetPath,
          resolvedPath: resolved,
          totalLines: lines.length,
          content: truncate(slice.map((line, index) => `${String(offset + index).padStart(5, ' ')}  ${line}`).join('\n')),
        };
      },
    }),
    defineTool({
      name: 'ls',
      description: 'List directory entries inside the workspace.',
      input: z.object({ path: z.string().default('.') }),
      approval: approval('ls'),
      execute: async ({ path: targetPath }) => {
        const resolved = resolveWorkspacePath(config, targetPath);
        const entries = await readdir(resolved, { withFileTypes: true });
        return entries
          .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'}\t${entry.name}`)
          .sort()
          .join('\n');
      },
    }),
    defineTool({
      name: 'grep',
      description: 'Search files with ripgrep when available and a Node fallback otherwise.',
      input: z.object({ pattern: z.string(), path: z.string().default('.'), glob: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) }),
      approval: approval('grep'),
      execute: async ({ pattern, path: targetPath, glob, limit }) => {
        const cwd = resolveWorkspacePath(config, targetPath);
        try {
          const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(limit)];
          if (glob !== undefined) args.push('--glob', glob);
          args.push(pattern, '.');
          const result = await execFileAsync('rg', args, { cwd, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
          return truncate(result.stdout);
        } catch (error) {
          const err = error as { stdout?: string; stderr?: string; code?: number };
          if (err.stdout) {
            return truncate(err.stdout);
          }
          if (err.code === 1) {
            return '';
          }
          throw new Error(err.stderr ?? String(error), { cause: error });
        }
      },
    }),
    defineTool({
      name: 'glob',
      description: 'Find files by a simple glob pattern inside the workspace.',
      input: z.object({ pattern: z.string(), path: z.string().default('.'), limit: z.number().int().min(1).max(1000).default(200) }),
      approval: approval('glob'),
      execute: async ({ pattern, path: targetPath, limit }) => {
        const cwd = resolveWorkspacePath(config, targetPath);
        const files = await walk(cwd, limit * 5);
        const matcher = globToRegExp(pattern);
        return files.filter((file) => matcher.test(path.relative(cwd, file))).slice(0, limit).join('\n');
      },
    }),
    defineTool({
      name: 'write',
      description: 'Create or overwrite a file. Requires approval outside bypass or accept-edits mode.',
      input: z.object({ path: z.string(), content: z.string(), reason: z.string().optional() }),
      approval: approval('write'),
      execute: async ({ path: targetPath, content, reason }) => {
        const resolved = resolveWorkspacePath(config, targetPath);
        const previous = await readOptionalText(resolved);
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, content, 'utf8');
        return {
          path: targetPath,
          bytes: Buffer.byteLength(content),
          reason: reason ?? 'write file',
          diff: createPreviewDiff(targetPath, previous, content),
        };
      },
    }),
    defineTool({
      name: 'edit',
      description: 'Replace a unique text fragment in a file. Fails when the old text is not unique.',
      input: z.object({ path: z.string(), oldText: z.string(), newText: z.string(), reason: z.string().optional() }),
      approval: approval('edit'),
      execute: async ({ path: targetPath, oldText, newText, reason }) => {
        const resolved = resolveWorkspacePath(config, targetPath);
        const current = await readFile(resolved, 'utf8');
        const first = current.indexOf(oldText);
        if (first === -1) {
          throw new Error(`Text not found in ${targetPath}`);
        }
        if (current.indexOf(oldText, first + oldText.length) !== -1) {
          throw new Error(`Text is not unique in ${targetPath}`);
        }
        const next = current.slice(0, first) + newText + current.slice(first + oldText.length);
        await writeFile(resolved, next, 'utf8');
        return {
          path: targetPath,
          reason: reason ?? 'edit file',
          diff: [
            `--- ${targetPath}`,
            `+++ ${targetPath}`,
            ...oldText.split(/\r?\n/).slice(0, 20).map((line: string) => `- ${line}`),
            ...newText.split(/\r?\n/).slice(0, 20).map((line: string) => `+ ${line}`),
          ].join('\n'),
        };
      },
    }),
    defineTool({
      name: 'bash',
      description: 'Run a shell command in the workspace with timeout and captured stdout/stderr.',
      input: z.object({ command: z.string(), timeoutMs: z.number().int().min(1000).max(120000).default(30000), cwd: z.string().optional(), reason: z.string().optional() }),
      approval: approval('bash'),
      execute: async ({ command, timeoutMs, cwd }) => {
        const shell = process.env.SHELL ?? '/bin/sh';
        const runCwd = cwd === undefined ? config.cwd : resolveWorkspacePath(config, cwd);
        const started = Date.now();
        try {
          const result = await execFileAsync(shell, ['-lc', command], { cwd: runCwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
          return { exitCode: 0, durationMs: Date.now() - started, stdout: truncate(result.stdout), stderr: truncate(result.stderr) };
        } catch (error) {
          const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
          return {
            exitCode: err.killed ? -1 : typeof err.code === 'number' ? err.code : 1,
            durationMs: Date.now() - started,
            stdout: truncate(err.stdout ?? ''),
            stderr: truncate(err.killed ? 'timeout' : (err.stderr ?? err.message)),
          };
        }
      },
    }),
    defineTool({
      name: 'todo',
      description: 'Record task status for the TUI task panel.',
      input: z.object({ items: z.array(z.object({ title: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })) }),
      approval: approval('todo'),
      execute: async ({ items }) => ({ items, updatedAt: new Date().toISOString() }),
    }),
    defineTool({
      name: 'delegate',
      description: 'Describe a subagent task. The current implementation records delegation metadata for RPC/TUI.',
      input: z.object({ agent: z.string(), task: z.string(), allowedTools: z.array(z.string()).default([]) }),
      approval: approval('delegate'),
      execute: async (input) => ({ delegated: true, ...input }),
    }),
    defineTool({
      name: 'tool_search',
      description: 'Search deferred tool metadata by query.',
      input: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).default(8) }),
      approval: approval('tool_search'),
      execute: async ({ query, limit }) => ({ query, limit, tools: ['read', 'ls', 'grep', 'glob', 'write', 'edit', 'bash', 'todo', 'delegate'] }),
    }),
    defineTool({
      name: 'web_fetch',
      description: 'Fetch a URL. Network access requires approval by default.',
      input: z.object({ url: z.string().url() }),
      approval: approval('web_fetch'),
      execute: async ({ url }) => {
        const response = await fetch(url);
        return { url, status: response.status, text: truncate(await response.text()) };
      },
    }),
    defineTool({
      name: 'web_search',
      description: 'Record a web search request for environments with external search adapters.',
      input: z.object({ query: z.string() }),
      approval: approval('web_search'),
      execute: async ({ query }) => ({ query, message: 'web_search adapter is not configured in this local runtime' }),
    }),
  ];
}

/** 生成工具列表的 CLI 视图。 */
export function describeCodingTools(): string {
  return [
    'read\tread file with line numbers',
    'ls\tlist directory',
    'grep\tsearch text with ripgrep',
    'glob\tmatch file paths',
    'write\tcreate or overwrite file',
    'edit\tunique text replacement',
    'bash\trun shell command',
    'todo\tupdate task panel',
    'delegate\trecord subagent delegation',
    'tool_search\tfind deferred tools',
    'web_fetch\tfetch URL',
    'web_search\trequest web search adapter',
  ].join('\n');
}

function resolveWorkspacePath(config: CodingAgentConfig, targetPath: string): string {
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(config.cwd, targetPath);
  const allowed = config.allowedPaths.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!allowed) {
    throw new Error(`Path not allowed: ${resolved}`);
  }
  return resolved;
}

async function walk(root: string, limit: number): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (result.length >= limit) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else {
        result.push(fullPath);
      }
      if (result.length >= limit) return;
    }
  }
  await visit(root);
  return result;
}

function truncate(value: string): string {
  return value.length > MAX_TOOL_OUTPUT ? `${value.slice(0, MAX_TOOL_OUTPUT)}\n... truncated ...` : value;
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function createPreviewDiff(targetPath: string, previous: string | null, next: string): string {
  const oldLines = (previous ?? '').split(/\r?\n/).slice(0, 40);
  const nextLines = next.split(/\r?\n/).slice(0, 40);
  const header = previous === null
    ? [`--- /dev/null`, `+++ ${targetPath}`]
    : [`--- ${targetPath}`, `+++ ${targetPath}`];
  return truncate([
    ...header,
    ...oldLines.map((line) => `- ${line}`),
    ...nextLines.map((line) => `+ ${line}`),
  ].join('\n'));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}
