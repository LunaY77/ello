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
import { SessionFileState } from './runtime/file-state.js';
import {
  findNearestLine,
  requireFs,
  resolveRuntimePath,
  statRuntimePath,
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
  fileState: SessionFileState = new SessionFileState(),
) {
  return [
    defineCodingTool({
      name: 'read',
      capabilities: () => ({
        concurrencySafe: true,
        readOnly: true,
        destructive: false,
        interruptible: true,
        telemetryTag: 'filesystem.read',
      }),
      description: `Read a UTF-8 text file, or list one directory, at 'filePath'.
File output is line-numbered in a right-aligned gutter followed by two spaces; the gutter is display only, so never copy it into edit or apply_patch. 'offset' is the 1-based first line or directory entry and 'limit' the maximum number of lines or entries, default 400 and at most 2000; the result reports the returned range and total count so you can page with successive offsets. Re-reading the same unchanged file range returns a short unchanged marker instead of duplicating content already present in the thread. A directory path returns a sorted, non-recursive listing of 'name<TAB>kind<TAB>size'. A binary file returns a byte count and is attached as an artifact rather than inlined.
A missing path, an unreadable path, or a path outside the allowed roots fails the call. Very long output is centrally reduced to a bounded head/tail preview while the complete result is retained as an artifact.
Read a file before editing it: edit and apply_patch match text literally, so they need the exact current content. Use grep to find which file contains some text, and glob to find files by name. Put independent read, grep, and glob calls directly in the same model response; the runtime schedules safe calls concurrently without a wrapper tool.`,
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
          const selectedEntries = entries.slice(offset - 1, offset - 1 + limit);
          const renderedEntries = await Promise.all(
            selectedEntries.map(async (entry) => {
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
          const nextOffset =
            offset - 1 + selectedEntries.length < entries.length
              ? offset + selectedEntries.length
              : undefined;
          renderedEntries.push(
            `[Listed ${selectedEntries.length} of ${entries.length} entries.${nextOffset === undefined ? '' : ` Continue with offset ${nextOffset}.`}]`,
          );
          return createCodingToolResult({
            title: `Directory ${targetPath}`,
            output: renderedEntries.join('\n'),
            metadata: {
              kind: 'read',
              path: targetPath,
              bytes: 0,
              entryCount: selectedEntries.length,
              totalEntries: entries.length,
              offset,
              ...(nextOffset === undefined ? {} : { nextOffset }),
              isDirectory: true,
            },
          });
        }
        const sourceStat = await stat(absolutePath);
        const cached = fileState.unchanged(absolutePath, sourceStat, {
          offset,
          limit,
        });
        if (cached !== undefined) {
          return createCodingToolResult({
            title: `Unchanged ${targetPath}`,
            output: `File unchanged since the previous read of ${targetPath} lines ${cached.lineStart}-${cached.lineEnd}. Reuse the earlier content already present in this thread.`,
            metadata: {
              kind: 'read',
              path: targetPath,
              bytes: cached.size,
              lineStart: cached.lineStart,
              lineEnd: cached.lineEnd,
              totalLines: cached.totalLines,
              mime: 'text/plain; charset=utf-8',
              unchanged: true,
            },
          });
        }
        const stableRead = await readStableFile(absolutePath, sourceStat);
        const buffer = stableRead.buffer;
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
        const lineEnd = offset + slice.length - 1;
        const content = slice
          .map(
            (line, index) =>
              `${String(offset + index).padStart(5, ' ')}  ${line}`,
          )
          .join('\n');
        const nextOffset = lineEnd < lines.length ? lineEnd + 1 : undefined;
        const modelOutput = [
          content,
          `[Read lines ${offset}-${lineEnd} of ${lines.length}.${nextOffset === undefined ? '' : ` Continue with offset ${nextOffset}.`}]`,
        ]
          .filter((part) => part !== '')
          .join('\n');
        fileState.record(
          absolutePath,
          stableRead.version,
          { offset, limit },
          {
            size: stableRead.version.size,
            lineStart: offset,
            lineEnd,
            totalLines: lines.length,
          },
        );
        return createCodingToolResult({
          title: `Read ${targetPath}`,
          output: modelOutput,
          metadata: {
            kind: 'read',
            path: targetPath,
            bytes: buffer.byteLength,
            lineStart: offset,
            lineEnd,
            totalLines: lines.length,
            mime: 'text/plain; charset=utf-8',
          },
        });
      },
    }),
    defineCodingTool({
      name: 'write',
      description: `Create a new file, or replace an existing file whole, with 'content' as its complete new text.
Use this for new files. Do not use it to change a file that already exists just to alter a few lines: sending a whole file costs output proportional to its size and loses the rest of the file if your copy is stale. Use edit for one fragment and apply_patch for several fragments or several files.
Overwriting an existing file requires 'expectedContent' to equal its current content exactly; the call fails when 'expectedContent' is missing or stale, which means re-read the file. Parent directories are created as needed. Writing outside the allowed roots fails, and the call requires approval unless the session runs in bypass or accept-edits mode.`,
      discovery: {
        aliases: ['create file', 'overwrite file'],
        risk: 'workspace-write',
      },
      input: z
        .object({
          filePath: z.string().min(1).describe('File path to write'),
          content: z.string().describe('Complete new file content'),
          expectedContent: z
            .string()
            .optional()
            .describe(
              'Exact current content; required to overwrite an existing file',
            ),
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
      description: `Replace one exact text fragment in an existing file. This is the preferred way to change a file that already exists: it sends only the changed region instead of the whole file, so prefer it over write for every modification.
Read the file first and copy 'oldText' verbatim from what read returned, without the line-number gutter. 'oldText' must appear exactly once in the file, matched literally with no regex and no whitespace normalization; include enough surrounding lines to make it unique. 'newText' replaces it verbatim and may be empty to delete the fragment.
Failures are precise and recoverable: several occurrences report the count and the line number of each match, zero occurrences report the nearest partial match with its line number and text. Both mean re-read the file or extend 'oldText'; neither is a reason to rewrite the file.
Boundaries: use write only to create a new file or to replace a file whole; use edit for a single fragment in one file; use apply_patch for several fragments at once, several files in one atomic change, or file creation, deletion, and renames.`,
      discovery: {
        aliases: ['replace text', 'modify file'],
        risk: 'workspace-write',
      },
      input: z
        .object({
          filePath: z.string().min(1).describe('File path to edit'),
          oldText: z
            .string()
            .min(1)
            .describe(
              'Exact text to replace, copied from the file and unique within it',
            ),
          newText: z
            .string()
            .describe('Replacement text; empty deletes the fragment'),
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
        const first = locateUniqueMatch(targetPath, current, oldText);
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
      description: `Apply file changes using the structured patch protocol. All operations in one patch are previewed in memory and then written together, so a patch either fully applies or changes nothing.
The patch must start with *** Begin Patch and end with *** End Patch. Use explicit *** Add File:, *** Delete File:, or *** Update File: operations, optionally followed by *** Move to: for a rename. Added file content and inserted update lines start with +; removed lines start with -; unchanged context lines start with a space. Do not use unified diff ---/+++ file headers and do not write @@ -1,4 +1,6 @@ line ranges; a bare @@, or @@ followed by a context line to anchor from, is all that is supported.
Removed and context lines must reproduce the file's current text, so read the file first. A line whose first character is none of ' ', '+', '-' fails the parse and the error echoes that line. Update hunks that cannot be located fail and the error echoes the expected lines.
Example:
*** Begin Patch
*** Update File: src/example.ts
@@
-old line
+new line
*** End Patch
Boundaries: use write to create a single new file, edit for one fragment in one file, and apply_patch when a change spans several fragments or several files, or when it deletes or renames files.`,
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

interface FileVersion {
  readonly mtimeMs: number;
  readonly size: number;
}

async function readStableFile(
  absolutePath: string,
  initialVersion: FileVersion,
): Promise<{ readonly buffer: Buffer; readonly version: FileVersion }> {
  let before = initialVersion;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const buffer = await readFile(absolutePath);
    const after = await stat(absolutePath);
    if (
      before.mtimeMs === after.mtimeMs &&
      before.size === after.size &&
      buffer.byteLength === after.size
    ) {
      return { buffer, version: after };
    }
    before = after;
  }
  throw new Error(`File changed while it was being read: ${absolutePath}`);
}

/**
 * 定位 `oldText` 的唯一匹配位置，非唯一或缺失时抛出可直接行动的错误。
 *
 * 唯一性是 edit 的核心不变量：多匹配必须报告数量和全部命中行号，零匹配必须
 * 报告最接近的部分匹配及其行号，否则调用方只能靠整文件重写绕过。
 */
function locateUniqueMatch(
  targetPath: string,
  content: string,
  oldText: string,
): number {
  const offsets = collectMatchOffsets(content, oldText);
  if (offsets.length === 1) {
    const only = offsets[0];
    if (only === undefined) {
      throw new Error(`Match offset list lost its only entry: ${targetPath}`);
    }
    return only;
  }
  if (offsets.length > 1) {
    const lines = offsets.map((offset) => lineNumberAt(content, offset));
    throw new Error(
      `oldText occurs ${offsets.length} times in ${targetPath}, at lines ${lines.join(', ')}; edit requires exactly one occurrence. Extend oldText with surrounding lines until it is unique, or apply one edit per occurrence.`,
    );
  }
  const firstNeedleLine = oldText.split('\n')[0];
  if (firstNeedleLine === undefined) {
    throw new Error(`oldText has no lines to match against ${targetPath}.`);
  }
  const nearest = findNearestLine(content.split('\n'), firstNeedleLine);
  if (nearest === undefined) {
    throw new Error(
      `oldText occurs 0 times in ${targetPath} and no line of it matches any line in the file. Re-read ${targetPath} and copy oldText from the returned content; whitespace, indentation, or line endings may differ from what you assumed.`,
    );
  }
  throw new Error(
    `oldText occurs 0 times in ${targetPath}. Nearest partial match is line ${nearest.line}: ${JSON.stringify(nearest.text)}. Re-read ${targetPath} and copy oldText from the returned content; whitespace, indentation, or line endings may differ from what you assumed.`,
  );
}

function collectMatchOffsets(content: string, oldText: string): number[] {
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const found = content.indexOf(oldText, from);
    if (found === -1) {
      return offsets;
    }
    offsets.push(found);
    from = found + oldText.length;
  }
}

function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === '\n') {
      line += 1;
    }
  }
  return line;
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
  const first = locateUniqueMatch(input.filePath, current, input.oldText);
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
