/**
 * 本文件负责 tool feature 的“fs”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { z } from 'zod';

import { errnoCode } from '../../../infra/filesystem.js';
import {
  cliInput,
  commandInput,
  defineCommand,
  structuredInput,
  type CommandExample,
} from '../../command/index.js';
import type { CodingAgentConfig } from '../../config/index.js';
import type { DecideApproval } from '../permissions/policy.js';
import type { PermissionMetadata } from '../permissions/types.js';

import {
  applyPatchPaths,
  parseApplyPatch,
  prepareApplyPatch,
} from './apply-patch.js';
import { createFileChange, summarizeFileChanges } from './file-change.js';
import { createCommandResult } from './runtime/command-result.js';
import { SessionFileState } from './runtime/file-state.js';
import {
  findNearestLine,
  requireFs,
  resolveRuntimePath,
  statRuntimePath,
} from './shared.js';

const READ_EXAMPLES = [
  {
    description: 'Read the first 80 lines of a file',
    frame: { args: ['README.md', '--limit', '80'] },
  },
] as const satisfies readonly CommandExample[];

const WRITE_EXAMPLES = [
  {
    description: 'Create a new text file',
    frame: { args: ['notes.txt'], body: 'First line\n' },
  },
] as const satisfies readonly CommandExample[];

const APPLY_PATCH_EXAMPLES = [
  {
    description: 'Create a file with a structured patch',
    frame: {
      body: `*** Begin Patch
*** Add File: notes.txt
+First line
*** End Patch`,
    },
  },
] as const satisfies readonly CommandExample[];

/**
 * 文件系统工具：read / write / edit / apply_patch。
 *
 * IO 全部委托给 `ctx.environment.fileSystem`，coding scope 由工具声明的路径进入
 * Tool Policy 判定；工具本身只负责产品化输出（行号、diff、字节数）。
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
export function createFsCommands(
  config: CodingAgentConfig,
  decide: DecideApproval,
  fileState: SessionFileState = new SessionFileState(),
) {
  const readInput = z
    .object({
      filePath: z.string().min(1).describe('File path to read'),
      offset: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe('First 1-based line or directory entry to return'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(400)
        .describe('Maximum number of lines or directory entries to return'),
    })
    .strict();
  const writeInput = z
    .object({
      filePath: z.string().min(1).describe('File path to write'),
      content: z.string().describe('Complete new file content'),
      expectedDigest: z
        .string()
        .regex(/^[a-f\d]{64}$/u)
        .optional()
        .describe(
          'SHA-256 returned by read; required to overwrite an existing file',
        ),
      reason: z.string().optional().describe('Reason for writing this file'),
    })
    .strict();
  const editInput = z
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
    .strict();
  const patchInput = z
    .object({
      patch: z
        .string()
        .min(1)
        .describe('Complete patch text in the format described above'),
      reason: z.string().optional().describe('Reason for applying this patch'),
    })
    .strict();
  return [
    defineCommand({
      name: 'read',
      summary: 'Read a UTF-8 text file or list one directory.',
      details: `Line numbers are a display gutter followed by two spaces; never copy them into a patch or file body. A directory path returns a sorted, non-recursive 'name<TAB>kind<TAB>size' listing. A binary file returns its byte count and is attached as an artifact instead of text. Re-reading an unchanged range returns a short unchanged marker rather than the same content again.
A missing or unreadable path fails the Command. Reading outside the configured coding scope requires approval.`,
      examples: READ_EXAMPLES,
      aliases: ['file', 'directory', 'cat'],
      risk: 'readonly',
      effects: () => ({
        concurrencySafe: true,
        readOnly: true,
        destructive: false,
        interruptible: true,
        telemetryTag: 'filesystem.read',
      }),
      invocation: cliInput(commandInput(readInput), {
        positionals: [{ field: 'filePath', metavar: 'path' }],
        options: ['offset', 'limit'],
      }),
      approval: (input, ctx) =>
        decide(
          {
            permission: 'read',
            patterns: [input.filePath],
            always: [input.filePath],
            paths: [input.filePath],
            metadata: { kind: 'read', path: input.filePath },
          },
          ctx,
        ),
      execution: {
        kind: 'immediate',
        run: async ({ filePath: targetPath, offset, limit }, ctx) => {
          const fs = requireFs(ctx);
          const absolutePath = resolveRuntimePath(fs, targetPath);
          const info = await statRuntimePath(fs, targetPath);
          if (info.kind === 'directory') {
            const entries = await fs.listDir(targetPath);
            entries.sort((left, right) => left.localeCompare(right));
            const selectedEntries = entries.slice(
              offset - 1,
              offset - 1 + limit,
            );
            const renderedEntries = await Promise.all(
              selectedEntries.map(async (entry) => {
                const entryInfo = await statRuntimePath(
                  fs,
                  path.join(targetPath, entry),
                );
                return `${entry}\t${entryInfo.kind}\t${entryInfo.size}`;
              }),
            );
            const nextOffset =
              offset - 1 + selectedEntries.length < entries.length
                ? offset + selectedEntries.length
                : undefined;
            renderedEntries.push(
              `[Listed ${selectedEntries.length} of ${entries.length} entries.${nextOffset === undefined ? '' : ` Continue with offset ${nextOffset}.`}]`,
            );
            return createCommandResult({
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
          const sourceStat = await fs.stat(targetPath);
          const sourceVersion = {
            mtimeMs: sourceStat.modifiedAtMs,
            size: sourceStat.size,
          };
          const cached = fileState.unchanged(absolutePath, sourceVersion, {
            offset,
            limit,
          });
          if (cached !== undefined) {
            return createCommandResult({
              title: `Unchanged ${targetPath}`,
              output: `File unchanged since the previous read of ${targetPath} lines ${cached.lineStart}-${cached.lineEnd}. Reuse the earlier content already present in this thread.`,
              metadata: {
                kind: 'read',
                path: targetPath,
                bytes: cached.size,
                lineStart: cached.lineStart,
                lineEnd: cached.lineEnd,
                totalLines: cached.totalLines,
                sha256: cached.digest,
                mime: 'text/plain; charset=utf-8',
                unchanged: true,
              },
            });
          }
          const stableRead = await readStableFile(
            fs,
            targetPath,
            sourceVersion,
          );
          const buffer = stableRead.buffer;
          if (isBinary(buffer)) {
            return createCommandResult({
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
                  content: buffer.toString('base64'),
                  name: targetPath,
                  bytes: buffer.byteLength,
                },
              ],
            });
          }
          const text = buffer.toString('utf8');
          const contentDigest = sha256(buffer);
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
              digest: contentDigest,
              size: stableRead.version.size,
              lineStart: offset,
              lineEnd,
              totalLines: lines.length,
            },
          );
          return createCommandResult({
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
              sha256: contentDigest,
            },
          });
        },
      },
    }),
    defineCommand({
      name: 'write',
      summary: 'Create a file or replace an existing file whole.',
      details: `Before overwriting an existing file, read it and pass the returned SHA-256 as 'expectedDigest'; a STALE_WRITE failure means the file changed and requires a fresh read. Parent directories are created as needed. Writing outside the configured coding scope requires approval.`,
      examples: WRITE_EXAMPLES,
      aliases: ['create file', 'overwrite file'],
      risk: 'workspace-write',
      invocation: cliInput(commandInput(writeInput), {
        positionals: [{ field: 'filePath', metavar: 'path' }],
        options: ['expectedDigest', 'reason'],
        body: 'content',
      }),
      approval: async (input, ctx) => {
        const descriptor = editDescriptor([input.filePath]);
        const pathDecision = decide(descriptor, ctx, {
          externalPathsOnly: true,
        });
        if (pathDecision !== 'auto') return pathDecision;
        return decide(
          { ...descriptor, metadata: await writeMetadata(input, ctx) },
          ctx,
        );
      },
      execution: {
        kind: 'immediate',
        run: async (
          { filePath: targetPath, content, expectedDigest, reason },
          ctx,
        ) => {
          const fs = requireFs(ctx);
          const previous = await readOptional(fs, targetPath);
          assertWriteExpectedDigest(targetPath, previous, expectedDigest);
          await fs.writeText(targetPath, content);
          const fileChanges = [createFileChange(targetPath, previous, content)];
          const summary = summarizeFileChanges(fileChanges);
          return createCommandResult({
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
      },
    }),
    defineCommand({
      name: 'edit',
      summary: 'Replace one exact text fragment in an existing file.',
      details: `'oldText' must appear exactly once and is matched literally; copy it from a fresh read without the line-number gutter. An empty 'newText' deletes the fragment.
Failures are precise: several matches report the count and each line number, no match reports the nearest partial match with its line number and text. Both mean re-read the file or extend 'oldText'.
Boundaries: write creates a file or replaces one whole, edit changes a single fragment in one file, apply_patch covers several fragments, several files, or file creation, deletion, and renames in one atomic change.`,
      aliases: ['replace text', 'modify file'],
      risk: 'workspace-write',
      invocation: structuredInput(commandInput(editInput)),
      approval: async (input, ctx) => {
        const descriptor = editDescriptor([input.filePath]);
        const pathDecision = decide(descriptor, ctx, {
          externalPathsOnly: true,
        });
        if (pathDecision !== 'auto') return pathDecision;
        return decide(
          { ...descriptor, metadata: await editMetadata(input, ctx) },
          ctx,
        );
      },
      execution: {
        kind: 'immediate',
        run: async (
          { filePath: targetPath, oldText, newText, reason },
          ctx,
        ) => {
          const fs = requireFs(ctx);
          const current = await fs.readText(targetPath);
          const first = locateUniqueMatch(targetPath, current, oldText);
          const next =
            current.slice(0, first) +
            newText +
            current.slice(first + oldText.length);
          await fs.writeText(targetPath, next);
          const fileChanges = [createFileChange(targetPath, current, next)];
          const summary = summarizeFileChanges(fileChanges);
          return createCommandResult({
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
      },
    }),
    defineCommand({
      name: 'apply_patch',
      summary: 'Apply a strict structured patch atomically.',
      details: `Every operation is previewed in memory and then written together, so a patch either fully applies or changes nothing.
Format: the body runs from *** Begin Patch to *** End Patch and holds *** Add File:, *** Delete File:, or *** Update File: operations; an update may add *** Move to: for a rename and separates hunks with @@ plus context. Added lines start with +, removed lines with -, and context lines with a space. Unified diff ---/+++ headers and numbered @@ ranges are rejected, and removed and context lines must reproduce the current file text.
Invalid syntax or an update hunk that cannot be located fails with the offending line or the expected context.`,
      examples: APPLY_PATCH_EXAMPLES,
      aliases: ['patch', 'structured patch', 'multi file edit'],
      risk: 'workspace-write',
      invocation: cliInput(commandInput(patchInput), {
        options: ['reason'],
        body: 'patch',
      }),
      approval: async (input, ctx) => {
        const patch = parseApplyPatch(input.patch);
        const paths = applyPatchPaths(patch);
        const descriptor = editDescriptor(paths);
        const pathDecision = decide(descriptor, ctx, {
          externalPathsOnly: true,
        });
        if (pathDecision !== 'auto') return pathDecision;
        const prepared = await prepareApplyPatch(requireFs(ctx), patch);
        return decide(
          {
            ...descriptor,
            metadata: {
              kind: 'edit',
              path: prepared.paths.join(', '),
              fileChanges: prepared.fileChanges,
            },
          },
          ctx,
        );
      },
      execution: {
        kind: 'immediate',
        run: async ({ patch, reason }, ctx) => {
          const fs = requireFs(ctx);
          const prepared = await prepareApplyPatch(fs, parseApplyPatch(patch));
          await prepared.apply();
          const summary = summarizeFileChanges(prepared.fileChanges);
          return createCommandResult({
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
      },
    }),
  ];
}

function editDescriptor(paths: readonly string[]) {
  return {
    permission: 'edit',
    patterns: paths,
    always: paths,
    paths,
    metadata: {
      kind: 'edit' as const,
      path: paths.join(', '),
    },
  };
}

interface FileVersion {
  readonly mtimeMs: number;
  readonly size: number;
}

async function readStableFile(
  fs: ReturnType<typeof requireFs>,
  targetPath: string,
  initialVersion: FileVersion,
): Promise<{ readonly buffer: Buffer; readonly version: FileVersion }> {
  let before = initialVersion;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const buffer = Buffer.from(await fs.readFile(targetPath));
    const stat = await fs.stat(targetPath);
    const after = { mtimeMs: stat.modifiedAtMs, size: stat.size };
    if (
      before.mtimeMs === after.mtimeMs &&
      before.size === after.size &&
      buffer.byteLength === after.size
    ) {
      return { buffer, version: after };
    }
    before = after;
  }
  throw new Error(`File changed while it was being read: ${targetPath}`);
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

function assertWriteExpectedDigest(
  targetPath: string,
  previous: string | null,
  expectedDigest: string | undefined,
): void {
  if (previous === null) {
    return;
  }
  if (expectedDigest === undefined) {
    throw new Error(
      `STALE_WRITE: refusing to overwrite existing file without expectedDigest: ${targetPath}`,
    );
  }
  const actualDigest = sha256(previous);
  if (expectedDigest !== actualDigest) {
    throw new Error(
      `STALE_WRITE: file changed since last read: ${targetPath} (expected ${expectedDigest}, actual ${actualDigest})`,
    );
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
    readonly expectedDigest?: string | undefined;
    readonly reason?: string | undefined;
  },
  ctx: Parameters<DecideApproval>[1],
): Promise<Extract<PermissionMetadata, { kind: 'edit' }>> {
  const previous = await readOptional(requireFs(ctx), input.filePath);
  assertWriteExpectedDigest(input.filePath, previous, input.expectedDigest);
  return {
    kind: 'edit',
    path: input.filePath,
    fileChanges: [createFileChange(input.filePath, previous, input.content)],
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
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
