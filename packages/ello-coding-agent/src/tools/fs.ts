import { readFile, stat } from 'node:fs/promises';

import { z } from 'zod';

import type { CodingAgentConfig } from '../config/index.js';

import {
  createCodingToolResult,
  defineCodingTool,
  type ToolMetadata,
} from './runtime/coding-tool.js';
import {
  createPreviewDiff,
  requireFs,
  resolveWorkspacePath,
  truncate,
  type ApprovalFor,
} from './shared.js';

/**
 * 文件系统工具：read / ls / write / edit。
 *
 * IO 与 allowedPaths 边界检查全部委托给 `ctx.environment.fileSystem`，
 * 工具本身只负责产品化输出（行号、diff、字节数）和声明审批策略。
 */
export function createFsTools(
  config: CodingAgentConfig,
  approval: ApprovalFor,
) {
  return [
    defineCodingTool({
      name: 'read',
      description:
        'Read a UTF-8 text file with optional offset and limit. Output includes line numbers.',
      input: z.object({
        path: z.string(),
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(2000).optional(),
      }),
      execute: async ({ path: targetPath, offset = 1, limit = 400 }, ctx) => {
        const absolutePath = resolveWorkspacePath(
          config.cwd,
          config.allowedPaths,
          targetPath,
        );
        const info = await stat(absolutePath);
        if (info.isDirectory()) {
          const entries = await requireFs(ctx.agent).listDir(targetPath);
          return createCodingToolResult({
            title: `Directory ${targetPath}`,
            output: entries.join('\n'),
            metadata: {
              kind: 'read',
              path: targetPath,
              bytes: 0,
              entryCount: entries.length,
              isDirectory: true,
            },
          });
        }
        const buffer = await readFile(absolutePath);
        if (isBinary(buffer)) {
          return createCodingToolResult({
            title: `Binary file ${targetPath}`,
            output: `Binary file ${targetPath} (${buffer.byteLength} bytes). Content is available as an attachment artifact only.`,
            metadata: {
              kind: 'read',
              path: targetPath,
              bytes: buffer.byteLength,
              mime: 'application/octet-stream',
              binary: true,
            },
            attachments: [
              {
                type: 'binary',
                mime: 'application/octet-stream',
                path: absolutePath,
                name: targetPath,
                bytes: buffer.byteLength,
              },
            ],
          });
        }
        const text = buffer.toString('utf8');
        const lines = text.split(/\r?\n/u);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const content = truncate(
          slice
            .map(
              (line, index) =>
                `${String(offset + index).padStart(5, ' ')}  ${line}`,
            )
            .join('\n'),
        );
        return createCodingToolResult({
          title: `Read ${targetPath}`,
          output: content,
          metadata: {
            kind: 'read',
            path: targetPath,
            bytes: buffer.byteLength,
            lineStart: offset,
            lineEnd: offset + slice.length - 1,
            totalLines: lines.length,
            mime: 'text/plain; charset=utf-8',
          },
        });
      },
    }),
    defineCodingTool({
      name: 'ls',
      description: 'List directory entries inside the workspace.',
      input: z.object({ path: z.string().default('.') }),
      execute: async ({ path: targetPath }, ctx) => {
        const entries = await requireFs(ctx.agent).listDir(targetPath);
        return createCodingToolResult({
          title: `List ${targetPath}`,
          output: entries.join('\n'),
          metadata: {
            kind: 'read',
            path: targetPath,
            entryCount: entries.length,
          },
        });
      },
    }),
    defineCodingTool({
      name: 'write',
      description:
        'Create or overwrite a file. Requires approval outside bypass or accept-edits mode.',
      input: z.object({
        path: z.string(),
        content: z.string(),
        reason: z.string().optional(),
      }),
      approval: async (input, ctx) =>
        withApprovalMetadata(
          await approval('write')(input as never, ctx.agent),
          await writeMetadata(input, ctx.agent),
        ),
      execute: async ({ path: targetPath, content, reason }, ctx) => {
        const fs = requireFs(ctx.agent);
        const previous = await readOptional(fs, targetPath);
        await fs.writeText(targetPath, content);
        const diff = createPreviewDiff(targetPath, previous, content);
        return createCodingToolResult({
          title: `Write ${targetPath}`,
          output: `Wrote ${Buffer.byteLength(content)} bytes to ${targetPath}.`,
          metadata: {
            kind: 'edit',
            path: targetPath,
            bytes: Buffer.byteLength(content),
            reason: reason ?? 'write file',
            diff,
            before: previous,
            after: content,
          },
        });
      },
    }),
    defineCodingTool({
      name: 'edit',
      description:
        'Replace a unique text fragment in a file. Fails when the old text is not unique.',
      input: z.object({
        path: z.string(),
        oldText: z.string(),
        newText: z.string(),
        reason: z.string().optional(),
      }),
      approval: async (input, ctx) =>
        withApprovalMetadata(
          await approval('edit')(input as never, ctx.agent),
          await editMetadata(input, ctx.agent),
        ),
      execute: async ({ path: targetPath, oldText, newText, reason }, ctx) => {
        const fs = requireFs(ctx.agent);
        const current = await fs.readText(targetPath);
        const first = current.indexOf(oldText);
        if (first === -1) {
          throw new Error(`Text not found in ${targetPath}`);
        }
        if (current.indexOf(oldText, first + oldText.length) !== -1) {
          throw new Error(`Text is not unique in ${targetPath}`);
        }
        const next =
          current.slice(0, first) +
          newText +
          current.slice(first + oldText.length);
        await fs.writeText(targetPath, next);
        const diff = createPreviewDiff(targetPath, current, next);
        return createCodingToolResult({
          title: `Edit ${targetPath}`,
          output: `Edited ${targetPath}.`,
          metadata: {
            kind: 'edit',
            path: targetPath,
            reason: reason ?? 'edit file',
            diff,
            before: current,
            after: next,
          },
        });
      },
    }),
  ];
}

/** 读文件，文件不存在时返回 null（供 write 生成 diff 用）。 */
async function readOptional(
  fs: { readText(path: string): Promise<string> },
  targetPath: string,
): Promise<string | null> {
  try {
    return await fs.readText(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return true;
  }
  return buffer.toString('utf8').includes('\uFFFD');
}

function withApprovalMetadata(
  decision: Awaited<ReturnType<ReturnType<ApprovalFor>>>,
  metadata: ToolMetadata,
): typeof decision {
  if (typeof decision === 'string') {
    return { action: decision, metadata };
  }
  return {
    ...decision,
    metadata: { ...metadata, ...(decision.metadata ?? {}) },
  };
}

async function writeMetadata(
  input: {
    readonly path: string;
    readonly content: string;
    readonly reason?: string | undefined;
  },
  ctx: Parameters<ReturnType<ApprovalFor>>[1],
): Promise<ToolMetadata> {
  const previous = await readOptional(requireFs(ctx), input.path);
  return {
    kind: 'edit',
    path: input.path,
    reason: input.reason ?? 'write file',
    diff: createPreviewDiff(input.path, previous, input.content),
  };
}

async function editMetadata(
  input: {
    readonly path: string;
    readonly oldText: string;
    readonly newText: string;
    readonly reason?: string | undefined;
  },
  ctx: Parameters<ReturnType<ApprovalFor>>[1],
): Promise<ToolMetadata> {
  const current = await requireFs(ctx).readText(input.path);
  const next = current.replace(input.oldText, input.newText);
  return {
    kind: 'edit',
    path: input.path,
    reason: input.reason ?? 'edit file',
    diff: createPreviewDiff(input.path, current, next),
  };
}
