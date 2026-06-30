import { defineTool, type AnyAgentTool } from '@ello/agent';
import { z } from 'zod';

import type { CodingAgentConfig } from '../config/index.js';

import {
  createPreviewDiff,
  requireFs,
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
  _config: CodingAgentConfig,
  approval: ApprovalFor,
): AnyAgentTool[] {
  return [
    defineTool({
      name: 'read',
      description:
        'Read a UTF-8 text file with optional offset and limit. Output includes line numbers.',
      input: z.object({
        path: z.string(),
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(2000).optional(),
      }),
      approval: approval('read'),
      execute: async ({ path: targetPath, offset = 1, limit = 400 }, ctx) => {
        const text = await requireFs(ctx).readText(targetPath);
        const lines = text.split(/\r?\n/u);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        return {
          path: targetPath,
          totalLines: lines.length,
          content: truncate(
            slice
              .map(
                (line, index) =>
                  `${String(offset + index).padStart(5, ' ')}  ${line}`,
              )
              .join('\n'),
          ),
        };
      },
    }),
    defineTool({
      name: 'ls',
      description: 'List directory entries inside the workspace.',
      input: z.object({ path: z.string().default('.') }),
      approval: approval('ls'),
      execute: async ({ path: targetPath }, ctx) => {
        const entries = await requireFs(ctx).listDir(targetPath);
        return { path: targetPath, entries };
      },
    }),
    defineTool({
      name: 'write',
      description:
        'Create or overwrite a file. Requires approval outside bypass or accept-edits mode.',
      input: z.object({
        path: z.string(),
        content: z.string(),
        reason: z.string().optional(),
      }),
      approval: approval('write'),
      execute: async ({ path: targetPath, content, reason }, ctx) => {
        const fs = requireFs(ctx);
        const previous = await readOptional(fs, targetPath);
        await fs.writeText(targetPath, content);
        return {
          path: targetPath,
          bytes: Buffer.byteLength(content),
          reason: reason ?? 'write file',
          diff: createPreviewDiff(targetPath, previous, content),
          // before/after 供 09 的检查点做回滚（v1 取舍：直接带在输出里）。
          before: previous,
          after: content,
        };
      },
    }),
    defineTool({
      name: 'edit',
      description:
        'Replace a unique text fragment in a file. Fails when the old text is not unique.',
      input: z.object({
        path: z.string(),
        oldText: z.string(),
        newText: z.string(),
        reason: z.string().optional(),
      }),
      approval: approval('edit'),
      execute: async ({ path: targetPath, oldText, newText, reason }, ctx) => {
        const fs = requireFs(ctx);
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
        return {
          path: targetPath,
          reason: reason ?? 'edit file',
          diff: createPreviewDiff(targetPath, current, next),
          // before/after 供 09 的检查点做回滚。
          before: current,
          after: next,
        };
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
