/**
 * 本文件负责 tool feature 的“fs”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { errnoCode } from '../../../infra/filesystem.js';
import type { CodingAgentConfig } from '../../config/index.js';
import type { DecideApproval } from '../permissions/policy.js';
import type { PermissionMetadata } from '../permissions/types.js';

import { parseApplyPatch, prepareApplyPatch } from './apply-patch.js';
import { createFileChange, summarizeFileChanges } from './file-change.js';
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
 * 文件系统工具：read / write / edit / apply_patch。
 *
 * IO 与 allowedPaths 边界检查全部委托给 `ctx.environment.fileSystem`，
 * 工具本身只负责产品化输出（行号、diff、字节数）和声明审批策略。
 *
 * Args:
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 * - `decide`: `createFsTools` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `createFsTools` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `fs` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createFsTools(
  config: CodingAgentConfig,
  decide: DecideApproval,
) {
  return [
    defineCodingTool({
      name: 'read',
      description:
        'Read a UTF-8 text file with optional offset and limit. Output includes line numbers.',
      discovery: { aliases: ['file', 'directory', 'cat'], risk: 'readonly' },
      input: z
        .object({
          filePath: z.string().min(1).describe('File path to read'),
          offset: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Starting line number (1-based)'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(2000)
            .optional()
            .describe('Maximum number of lines to return'),
        })
        .strict(),
      approval: (input, ctx) =>
        decide(
          {
            permission: 'read',
            patterns: [input.filePath],
            always: [input.filePath],
            paths: [input.filePath],
            metadata: { kind: 'read', path: input.filePath },
          },
          ctx.agent,
        ),
      execute: async (
        { filePath: targetPath, offset = 1, limit = 400 },
        ctx,
      ) => {
        const fs = requireFs(ctx.agent);
        const absolutePath = resolveRuntimePath(fs, targetPath);
        const info = await statRuntimePath(fs, targetPath);
        if (info.isDirectory()) {
          const entries = await fs.listDir(targetPath);
          entries.sort((left, right) => left.localeCompare(right));
          const renderedEntries = await Promise.all(
            entries.map(async (entry) => {
              const entryInfo = await statRuntimePath(
                fs,
                path.join(targetPath, entry),
              );
              const entryStat = await stat(
                resolveRuntimePath(fs, path.join(targetPath, entry)),
              );
              return `${entry}\t${entryInfo.isDirectory() ? 'directory' : 'file'}\t${entryStat.size}`;
            }),
          );
          return createCodingToolResult({
            title: `Directory ${targetPath}`,
            output: renderedEntries.join('\n'),
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
      name: 'write',
      description:
        'Create or overwrite a file. Requires approval outside bypass or accept-edits mode.',
      discovery: {
        aliases: ['create file', 'overwrite file'],
        risk: 'workspace-write',
      },
      input: z
        .object({
          filePath: z.string().min(1).describe('File path to write'),
          content: z.string().describe('File content to write'),
          expectedContent: z
            .string()
            .optional()
            .describe('Expected current content for safe overwrite'),
          reason: z
            .string()
            .optional()
            .describe('Reason for writing this file'),
        })
        .strict(),
      approval: async (input, ctx) =>
        decide(
          {
            permission: 'edit',
            patterns: [input.filePath],
            always: [input.filePath],
            paths: [input.filePath],
            metadata: await writeMetadata(input, ctx.agent),
          },
          ctx.agent,
        ),
      execute: async (
        { filePath: targetPath, content, expectedContent, reason },
        ctx,
      ) => {
        const fs = requireFs(ctx.agent);
        const previous = await readOptional(fs, targetPath);
        assertWriteExpectedContent(targetPath, previous, expectedContent);
        await fs.writeText(targetPath, content);
        const fileChanges = [createFileChange(targetPath, previous, content)];
        const summary = summarizeFileChanges(fileChanges);
        return createCodingToolResult({
          title: `Write ${targetPath}`,
          output: `Wrote ${Buffer.byteLength(content)} bytes to ${targetPath} (+${summary.additions} -${summary.deletions}).`,
          metadata: {
            kind: 'edit',
            path: targetPath,
            bytes: Buffer.byteLength(content),
            reason: reason ?? 'write file',
            fileChanges,
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
      discovery: {
        aliases: ['replace text', 'modify file'],
        risk: 'workspace-write',
      },
      input: z
        .object({
          filePath: z.string().min(1).describe('File path to edit'),
          oldText: z.string().min(1).describe('Text to find and replace'),
          newText: z.string().describe('Replacement text'),
          reason: z.string().optional().describe('Reason for this edit'),
        })
        .strict(),
      approval: async (input, ctx) =>
        decide(
          {
            permission: 'edit',
            patterns: [input.filePath],
            always: [input.filePath],
            paths: [input.filePath],
            metadata: await editMetadata(input, ctx.agent),
          },
          ctx.agent,
        ),
      execute: async (
        { filePath: targetPath, oldText, newText, reason },
        ctx,
      ) => {
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
        const fileChanges = [createFileChange(targetPath, current, next)];
        const summary = summarizeFileChanges(fileChanges);
        return createCodingToolResult({
          title: `Edit ${targetPath}`,
          output: `Edited ${targetPath} (+${summary.additions} -${summary.deletions}).`,
          metadata: {
            kind: 'edit',
            path: targetPath,
            reason: reason ?? 'edit file',
            fileChanges,
            before: current,
            after: next,
          },
        });
      },
    }),
    defineCodingTool({
      name: 'apply_patch',
      description: `Apply file changes using the structured patch protocol.
The patch must start with *** Begin Patch and end with *** End Patch. Use explicit *** Add File:, *** Delete File:, or *** Update File: operations. Added file content and inserted update lines start with +; removed lines start with -; unchanged context lines start with a space. Do not use unified diff ---/+++ file headers.
Example:
*** Begin Patch
*** Update File: src/example.ts
@@
-old line
+new line
*** End Patch`,
      discovery: {
        aliases: ['patch', 'structured patch', 'multi file edit'],
        risk: 'workspace-write',
      },
      input: z
        .object({
          patch: z
            .string()
            .min(1)
            .describe(
              "Patch text using *** Begin Patch / *** End Patch. Update hunks use @@ plus context, '-' removed lines, and '+' added lines.",
            ),
          reason: z
            .string()
            .optional()
            .describe('Reason for applying this patch'),
        })
        .strict(),
      approval: async (input, ctx) => {
        const fs = requireFs(ctx.agent);
        const prepared = await prepareApplyPatch(
          fs,
          parseApplyPatch(input.patch),
        );
        return decide(
          {
            permission: 'edit',
            patterns: prepared.paths,
            always: prepared.paths,
            paths: prepared.paths,
            metadata: {
              kind: 'edit',
              path: prepared.paths.join(', '),
              fileChanges: prepared.fileChanges,
            },
          },
          ctx.agent,
        );
      },
      execute: async ({ patch, reason }, ctx) => {
        const fs = requireFs(ctx.agent);
        const prepared = await prepareApplyPatch(fs, parseApplyPatch(patch));
        await prepared.apply();
        const summary = summarizeFileChanges(prepared.fileChanges);
        return createCodingToolResult({
          title: `Apply patch ${prepared.paths.join(', ')}`,
          output: `Applied patch to ${prepared.paths.length} file(s) (+${summary.additions} -${summary.deletions}).`,
          metadata: {
            kind: 'edit',
            path: prepared.paths.join(', '),
            paths: prepared.paths,
            reason: reason ?? 'apply patch',
            fileChanges: prepared.fileChanges,
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
    if (errnoCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function assertWriteExpectedContent(
  targetPath: string,
  previous: string | null,
  expectedContent: string | undefined,
): void {
  if (previous === null) {
    return;
  }
  if (expectedContent === undefined) {
    throw new Error(
      `Refusing to overwrite existing file without expectedContent: ${targetPath}`,
    );
  }
  if (expectedContent !== previous) {
    throw new Error(`File changed since last read: ${targetPath}`);
  }
}

function isBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return true;
  }
  return buffer.toString('utf8').includes('\uFFFD');
}

async function writeMetadata(
  input: {
    readonly filePath: string;
    readonly content: string;
    readonly expectedContent?: string | undefined;
    readonly reason?: string | undefined;
  },
  ctx: Parameters<DecideApproval>[1],
): Promise<Extract<PermissionMetadata, { kind: 'edit' }>> {
  const previous = await readOptional(requireFs(ctx), input.filePath);
  if (previous !== null && input.expectedContent !== previous) {
    throw new Error(`File changed since last read: ${input.filePath}`);
  }
  return {
    kind: 'edit',
    path: input.filePath,
    fileChanges: [createFileChange(input.filePath, previous, input.content)],
  };
}

async function editMetadata(
  input: {
    readonly filePath: string;
    readonly oldText: string;
    readonly newText: string;
    readonly reason?: string | undefined;
  },
  ctx: Parameters<DecideApproval>[1],
): Promise<Extract<PermissionMetadata, { kind: 'edit' }>> {
  const current = await requireFs(ctx).readText(input.filePath);
  const first = current.indexOf(input.oldText);
  if (first === -1) {
    throw new Error(`Text not found in ${input.filePath}`);
  }
  if (current.indexOf(input.oldText, first + input.oldText.length) !== -1) {
    throw new Error(`Text is not unique in ${input.filePath}`);
  }
  const next =
    current.slice(0, first) +
    input.newText +
    current.slice(first + input.oldText.length);
  return {
    kind: 'edit',
    path: input.filePath,
    fileChanges: [createFileChange(input.filePath, current, next)],
  };
}
