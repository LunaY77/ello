/**
 * 结构化 patch 协议的解析与执行。
 *
 * 输入以 Begin/End 标记包裹，由 Add/Delete/Update 三类文件操作组成；Update
 * 还可以声明 Move。模块刻意分成 parse、prepare、apply 三段：审批阶段只做解析和
 * 完整预览，真正获批后才一次性写入，避免长 patch 在中途失败时留下半成品。
 */
import { rm } from 'node:fs/promises';

import { errnoCode } from '../../../infra/filesystem.js';
import type { AgentFileSystem } from '../../agent/engine/index.js';

import { createFileChange, type FileChange } from './file-change.js';
import { resolveRuntimePath } from './shared.js';

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File: ';
const DELETE_FILE = '*** Delete File: ';
const UPDATE_FILE = '*** Update File: ';
const MOVE_TO = '*** Move to: ';
const END_OF_FILE = '*** End of File';

/** Update 操作中的一个上下文块；旧行用于定位，新行用于替换。 */
export interface ApplyPatchChunk {
  readonly changeContext?: string;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly isEndOfFile: boolean;
}

/** 解析后的文件级操作，作为字符串协议与文件系统执行之间的稳定边界。 */
export type ApplyPatchOperation =
  | { readonly kind: 'add'; readonly path: string; readonly content: string }
  | { readonly kind: 'delete'; readonly path: string }
  | {
      readonly kind: 'update';
      readonly path: string;
      readonly movePath?: string;
      readonly chunks: readonly ApplyPatchChunk[];
    };

/** 一次 patch 调用包含的有序文件操作。 */
export interface ApplyPatch {
  readonly operations: readonly ApplyPatchOperation[];
}

/**
 * 已完成路径校验和内容推演的 patch。
 * `fileChanges` 供审批与 UI 展示，`apply` 是唯一产生文件系统副作用的入口。
 */
export interface PreparedApplyPatch {
  readonly fileChanges: readonly FileChange[];
  readonly paths: readonly string[];
  /**
   * 在 工具 `apply-patch` 模块 中执行 `apply` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 工具 `apply-patch` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  apply(): Promise<void>;
}

/**
 * 严格解析 patch 外层标记和文件操作，遇到未知语法立即报告具体行号。
 *
 * Args:
 * - `patchText`: `parseApplyPatch` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `parseApplyPatch` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `apply-patch` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function parseApplyPatch(patchText: string): ApplyPatch {
  const lines = patchText.split(/\r?\n/u);
  while (lines.length > 0 && lines.at(-1)?.trim() === '') {
    lines.pop();
  }
  if (lines[0]?.trim() !== BEGIN_PATCH) {
    throw new Error(`Invalid patch: first line must be '${BEGIN_PATCH}'.`);
  }
  if (lines.at(-1)?.trim() !== END_PATCH) {
    throw new Error(`Invalid patch: last line must be '${END_PATCH}'.`);
  }

  const operations: ApplyPatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index];
    if (line === undefined) {
      throw invalidLine(index, 'patch ended before the end marker');
    }
    const marker = line.trim();
    if (marker === '') {
      index += 1;
      continue;
    }
    if (marker.startsWith(ADD_FILE)) {
      const path = readPath(marker, ADD_FILE, index);
      const parsed = parseAdd(lines, index + 1, path);
      operations.push(parsed.operation);
      index = parsed.nextIndex;
      continue;
    }
    if (marker.startsWith(DELETE_FILE)) {
      operations.push({
        kind: 'delete',
        path: readPath(marker, DELETE_FILE, index),
      });
      index += 1;
      continue;
    }
    if (marker.startsWith(UPDATE_FILE)) {
      const path = readPath(marker, UPDATE_FILE, index);
      const parsed = parseUpdate(lines, index + 1, path);
      operations.push(parsed.operation);
      index = parsed.nextIndex;
      continue;
    }
    throw invalidLine(
      index,
      `expected '${ADD_FILE.trim()}', '${DELETE_FILE.trim()}', or '${UPDATE_FILE.trim()}'`,
    );
  }
  if (operations.length === 0) {
    throw new Error('Invalid patch: patch contains no file operations.');
  }
  return { operations };
}

/**
 * 在内存中顺序推演全部操作并生成结构化 diff。
 *
 * `initial` 保存磁盘初始状态，`current` 充当虚拟文件系统，因此同一 patch 中后续
 * 操作可以看到前序操作的结果，同时任何预览错误都不会触碰真实文件。
 *
 * Args:
 * - `fs`: `prepareApplyPatch` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `patch`: `prepareApplyPatch` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - Promise 在 工具 `apply-patch` 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export async function prepareApplyPatch(
  fs: AgentFileSystem,
  patch: ApplyPatch,
): Promise<PreparedApplyPatch> {
  const initial = new Map<string, string | null>();
  const current = new Map<string, string | null>();
  const fileChanges: FileChange[] = [];

  const readState = async (path: string): Promise<string | null> => {
    resolveRuntimePath(fs, path);
    if (current.has(path)) {
      const content = current.get(path);
      if (content === undefined) {
        throw new Error(`Virtual patch state lost tracked path: ${path}`);
      }
      return content;
    }
    const content = await readOptional(fs, path);
    initial.set(path, content);
    current.set(path, content);
    return content;
  };

  for (const operation of patch.operations) {
    if (operation.kind === 'add') {
      const before = await readState(operation.path);
      current.set(operation.path, operation.content);
      fileChanges.push(
        createFileChange(operation.path, before, operation.content),
      );
      continue;
    }

    const before = await readState(operation.path);
    if (before === null) {
      throw new Error(
        `Cannot ${operation.kind} file because it does not exist: ${operation.path}`,
      );
    }
    if (operation.kind === 'delete') {
      current.set(operation.path, null);
      fileChanges.push(createFileChange(operation.path, before, null));
      continue;
    }

    const after = applyUpdateChunks(before, operation.path, operation.chunks);
    if (operation.movePath === undefined) {
      current.set(operation.path, after);
      fileChanges.push(createFileChange(operation.path, before, after));
      continue;
    }
    if (operation.movePath === operation.path) {
      throw new Error(
        `Patch move destination matches source: ${operation.path}`,
      );
    }
    await readState(operation.movePath);
    current.set(operation.path, null);
    current.set(operation.movePath, after);
    fileChanges.push(
      createFileChange(operation.path, before, after, operation.movePath),
    );
  }

  const paths = [...current.keys()];
  return {
    fileChanges,
    paths,
    async apply() {
      // 先删除再写入，保证 move 的源路径不会覆盖目标路径的最终内容。
      for (const [path, content] of current) {
        if (content === null && initial.get(path) !== null) {
          await rm(resolveRuntimePath(fs, path));
        }
      }
      for (const [path, content] of current) {
        if (content !== null && content !== initial.get(path)) {
          await fs.writeText(path, content);
        }
      }
    },
  };
}

function parseAdd(
  lines: readonly string[],
  start: number,
  path: string,
): { operation: ApplyPatchOperation; nextIndex: number } {
  const content: string[] = [];
  let index = start;
  while (index < lines.length - 1) {
    const line = lines[index];
    if (line === undefined) {
      throw invalidLine(
        index,
        `add file hunk for '${path}' ended unexpectedly`,
      );
    }
    if (isOperationLine(line)) break;
    if (!line.startsWith('+')) {
      throw invalidLine(index, `added file lines must start with '+'`);
    }
    content.push(line.slice(1));
    index += 1;
  }
  if (content.length === 0) {
    throw new Error(`Invalid patch: add file hunk for '${path}' is empty.`);
  }
  return {
    operation: { kind: 'add', path, content: `${content.join('\n')}\n` },
    nextIndex: index,
  };
}

function parseUpdate(
  lines: readonly string[],
  start: number,
  path: string,
): { operation: ApplyPatchOperation; nextIndex: number } {
  let index = start;
  let movePath: string | undefined;
  const possibleMove = lines[index]?.trim();
  if (possibleMove?.startsWith(MOVE_TO)) {
    movePath = readPath(possibleMove, MOVE_TO, index);
    index += 1;
  }
  const chunks: ApplyPatchChunk[] = [];
  while (index < lines.length - 1) {
    const line = lines[index];
    if (line === undefined) {
      throw invalidLine(
        index,
        `update file hunk for '${path}' ended unexpectedly`,
      );
    }
    if (isOperationLine(line)) break;
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const parsed = parseChunk(lines, index);
    chunks.push(parsed.chunk);
    index = parsed.nextIndex;
  }
  if (chunks.length === 0) {
    throw new Error(`Invalid patch: update file hunk for '${path}' is empty.`);
  }
  return {
    operation: {
      kind: 'update',
      path,
      ...(movePath !== undefined ? { movePath } : {}),
      chunks,
    },
    nextIndex: index,
  };
}

function parseChunk(
  lines: readonly string[],
  start: number,
): { chunk: ApplyPatchChunk; nextIndex: number } {
  let index = start;
  let changeContext: string | undefined;
  const firstLine = lines[index];
  if (firstLine === undefined) {
    throw invalidLine(index, 'update chunk is missing');
  }
  const header = firstLine.trim();
  if (header === '@@' || header.startsWith('@@ ')) {
    changeContext = header === '@@' ? undefined : header.slice(3);
    index += 1;
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let isEndOfFile = false;
  while (index < lines.length - 1) {
    const line = lines[index];
    if (line === undefined) {
      throw invalidLine(index, 'update chunk ended unexpectedly');
    }
    if (isOperationLine(line) || line === '@@' || line.startsWith('@@ ')) {
      break;
    }
    if (line.trim() === END_OF_FILE) {
      isEndOfFile = true;
      index += 1;
      break;
    }
    const marker = line[0];
    const content = line.slice(1);
    // 上下文行同时进入 old/new；增删行只进入各自一侧。
    if (marker === ' ') {
      oldLines.push(content);
      newLines.push(content);
    } else if (marker === '-') {
      oldLines.push(content);
    } else if (marker === '+') {
      newLines.push(content);
    } else {
      throw invalidLine(index, `update lines must start with ' ', '+', or '-'`);
    }
    index += 1;
  }
  if (oldLines.length === 0 && newLines.length === 0) {
    throw invalidLine(start, 'update chunk is empty');
  }
  return {
    chunk: {
      ...(changeContext !== undefined ? { changeContext } : {}),
      oldLines,
      newLines,
      isEndOfFile,
    },
    nextIndex: index,
  };
}

function applyUpdateChunks(
  content: string,
  path: string,
  chunks: readonly ApplyPatchChunk[],
): string {
  // 统一移除 split 产生的末尾哨兵，完成替换后再恢复结尾换行。
  const lines = content.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const replacements: Array<{
    readonly start: number;
    readonly oldLength: number;
    readonly newLines: readonly string[];
  }> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const contextIndex = seekSequence(
        lines,
        [chunk.changeContext],
        lineIndex,
        false,
      );
      if (contextIndex === undefined) {
        throw new Error(
          `Failed to find context '${chunk.changeContext}' in ${path}`,
        );
      }
      lineIndex = contextIndex + 1;
    }
    if (chunk.oldLines.length === 0) {
      // 无旧行的纯新增块按协议追加到文件末尾。
      replacements.push({
        start: lines.length,
        oldLength: 0,
        newLines: chunk.newLines,
      });
      continue;
    }
    let pattern = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
    if (found === undefined && pattern.at(-1) === '') {
      pattern = pattern.slice(0, -1);
      if (newLines.at(-1) === '') {
        newLines = newLines.slice(0, -1);
      }
      found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
    }
    if (found === undefined) {
      throw new Error(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`,
      );
    }
    replacements.push({
      start: found,
      oldLength: pattern.length,
      newLines,
    });
    lineIndex = found + pattern.length;
  }

  // 从后往前应用，避免前面的 splice 改变后续替换块的下标。
  for (const replacement of replacements.toReversed()) {
    lines.splice(
      replacement.start,
      replacement.oldLength,
      ...replacement.newLines,
    );
  }
  return `${lines.join('\n')}\n`;
}

function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
): number | undefined {
  if (pattern.length === 0) {
    return start;
  }
  if (pattern.length > lines.length) {
    return undefined;
  }
  const first = endOfFile ? lines.length - pattern.length : start;
  // 匹配强度逐级放宽：精确、忽略尾空白、忽略两侧空白、统一常见 Unicode 标点。
  const matchers = [
    (value: string) => value,
    (value: string) => value.trimEnd(),
    (value: string) => value.trim(),
    normalizeUnicode,
  ];
  for (const normalize of matchers) {
    for (
      let index = first;
      index <= lines.length - pattern.length;
      index += 1
    ) {
      let matches = true;
      for (const [offset, line] of pattern.entries()) {
        const candidate = lines[index + offset];
        if (
          candidate === undefined ||
          normalize(candidate) !== normalize(line)
        ) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return index;
      }
    }
  }
  return undefined;
}

function isOperationLine(line: string): boolean {
  const marker = line.trim();
  return (
    marker.startsWith(ADD_FILE) ||
    marker.startsWith(DELETE_FILE) ||
    marker.startsWith(UPDATE_FILE)
  );
}

function normalizeUnicode(value: string): string {
  return value
    .trim()
    .replace(/[‐‑‒–—―−]/gu, '-')
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/gu, ' ');
}

function readPath(line: string, prefix: string, index: number): string {
  const path = line.slice(prefix.length).trim();
  if (path === '') {
    throw invalidLine(index, 'file path is empty');
  }
  return path;
}

function invalidLine(index: number, message: string): Error {
  return new Error(`Invalid patch at line ${index + 1}: ${message}.`);
}

async function readOptional(
  fs: AgentFileSystem,
  path: string,
): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
