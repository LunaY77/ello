import { readFile } from 'node:fs/promises';

import { applyPatch as applyUnifiedPatch } from 'diff';
import { z } from 'zod';

import type { CodingAgentConfig } from '../config/index.js';
import type { DecideApproval } from '../permission/policy.js';
import type { PermissionMetadata } from '../permission/types.js';

import {
  applyStructuredPatches,
  createFileChange,
  parseUnifiedFileChanges,
  summarizeFileChanges,
  type FileChange,
} from './file-change.js';
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
 * 文件系统工具：read / ls / write / edit。
 *
 * IO 与 allowedPaths 边界检查全部委托给 `ctx.environment.fileSystem`，
 * 工具本身只负责产品化输出（行号、diff、字节数）和声明审批策略。
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
      input: z.object({
        path: z.string(),
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(2000).optional(),
      }),
      approval: (input, ctx) =>
        decide(
          {
            permission: 'read',
            patterns: [input.path],
            always: [input.path],
            paths: [input.path],
            metadata: { kind: 'read', path: input.path },
          },
          ctx.agent,
        ),
      execute: async ({ path: targetPath, offset = 1, limit = 400 }, ctx) => {
        const fs = requireFs(ctx.agent);
        const absolutePath = resolveRuntimePath(fs, targetPath);
        const info = await statRuntimePath(fs, targetPath);
        if (info.isDirectory()) {
          const entries = await fs.listDir(targetPath);
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
      approval: (input, ctx) =>
        decide(
          {
            permission: 'read',
            patterns: [input.path],
            always: [input.path],
            paths: [input.path],
            metadata: { kind: 'read', path: input.path },
          },
          ctx.agent,
        ),
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
        expectedContent: z.string().optional(),
        reason: z.string().optional(),
      }),
      approval: async (input, ctx) =>
        decide(
          {
            permission: 'edit',
            patterns: [input.path],
            always: [input.path],
            paths: [input.path],
            metadata: await writeMetadata(input, ctx.agent),
          },
          ctx.agent,
        ),
      execute: async (
        { path: targetPath, content, expectedContent, reason },
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
      input: z.object({
        path: z.string(),
        oldText: z.string(),
        newText: z.string(),
        reason: z.string().optional(),
      }),
      approval: async (input, ctx) =>
        decide(
          {
            permission: 'edit',
            patterns: [input.path],
            always: [input.path],
            paths: [input.path],
            metadata: await editMetadata(input, ctx.agent),
          },
          ctx.agent,
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
      description:
        'Apply a unified diff patch with exact context matching. The patch must include file headers and apply cleanly.',
      input: z.object({
        patch: z.string(),
        reason: z.string().optional(),
      }),
      approval: async (input, ctx) => {
        const fs = requireFs(ctx.agent);
        const patches = parseUnifiedFileChanges(input.patch);
        const fileChanges = await previewPatchChanges(fs, patches);
        const paths = fileChanges.map((change) => change.path);
        return decide(
          {
            permission: 'edit',
            patterns: paths,
            always: paths,
            paths,
            metadata: {
              kind: 'edit',
              path: paths.join(', '),
              fileChanges,
            },
          },
          ctx.agent,
        );
      },
      execute: async ({ patch, reason }, ctx) => {
        const fs = requireFs(ctx.agent);
        const fileChanges = await applyStructuredPatches(
          fs,
          parseUnifiedFileChanges(patch),
        );
        const paths = fileChanges.map((change) => change.path);
        const summary = summarizeFileChanges(fileChanges);
        return createCodingToolResult({
          title: `Apply patch ${paths.join(', ')}`,
          output: `Applied patch to ${paths.length} file(s) (+${summary.additions} -${summary.deletions}).`,
          metadata: {
            kind: 'edit',
            path: paths.join(', '),
            paths,
            reason: reason ?? 'apply patch',
            fileChanges,
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
    readonly path: string;
    readonly content: string;
    readonly expectedContent?: string | undefined;
    readonly reason?: string | undefined;
  },
  ctx: Parameters<DecideApproval>[1],
): Promise<Extract<PermissionMetadata, { kind: 'edit' }>> {
  const previous = await readOptional(requireFs(ctx), input.path);
  if (previous !== null && input.expectedContent !== previous) {
    throw new Error(`File changed since last read: ${input.path}`);
  }
  return {
    kind: 'edit',
    path: input.path,
    fileChanges: [createFileChange(input.path, previous, input.content)],
  };
}

async function editMetadata(
  input: {
    readonly path: string;
    readonly oldText: string;
    readonly newText: string;
    readonly reason?: string | undefined;
  },
  ctx: Parameters<DecideApproval>[1],
): Promise<Extract<PermissionMetadata, { kind: 'edit' }>> {
  const current = await requireFs(ctx).readText(input.path);
  const first = current.indexOf(input.oldText);
  if (first === -1) {
    throw new Error(`Text not found in ${input.path}`);
  }
  if (current.indexOf(input.oldText, first + input.oldText.length) !== -1) {
    throw new Error(`Text is not unique in ${input.path}`);
  }
  const next =
    current.slice(0, first) +
    input.newText +
    current.slice(first + input.oldText.length);
  return {
    kind: 'edit',
    path: input.path,
    fileChanges: [createFileChange(input.path, current, next)],
  };
}

async function previewPatchChanges(
  fs: ReturnType<typeof requireFs>,
  patches: Parameters<typeof applyStructuredPatches>[1],
): Promise<readonly FileChange[]> {
  const changes: FileChange[] = [];
  for (const patch of patches) {
    const path =
      patch.isDelete === true ? patch.oldFileName : patch.newFileName;
    if (path === undefined || path === '/dev/null') {
      throw new Error('Patch file name is missing.');
    }
    const targetPath = path.replace(/^[ab]\//u, '');
    resolveRuntimePath(fs, targetPath);
    const before =
      patch.isCreate === true ? null : await fs.readText(targetPath);
    const applied = applyUnifiedPatch(before ?? '', patch, { fuzzFactor: 0 });
    if (applied === false) {
      throw new Error(`Patch did not apply cleanly: ${targetPath}`);
    }
    changes.push(
      createFileChange(
        targetPath,
        before,
        patch.isDelete === true ? null : applied,
      ),
    );
  }
  return changes;
}
