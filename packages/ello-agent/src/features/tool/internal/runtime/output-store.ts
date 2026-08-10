/**
 * 本文件负责 Command 大输出的 artifact 持久化。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TRUNCATION_HEAD_RATIO, truncationMarker } from '../shared.js';

export interface CommandOutputLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly previewLines: number;
}

export interface CommandOutputStore {
  /**
   * 按 Command output-store 的一致性约束执行 `writeLargeOutput` 状态变更。
   *
   * Args:
   * - `input`: `writeLargeOutput` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 Command output-store 的异步写入完成后兑现为声明结果。
   *
   * Throws:
   * - 当输入或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  writeLargeOutput(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly callId: string;
    readonly content: string;
    readonly preferredName: string;
  }): Promise<{ readonly outputPath: string }>;
}

export class SessionCommandOutputStore implements CommandOutputStore {
  /**
   * 创建 `SessionCommandOutputStore`，由实例持有 session artifact 根目录。
   *
   * Args:
   * - `sessionDir`: `constructor SessionCommandOutputStore` 所需的业务值；函数按声明读取，不补造缺失内容。
   */
  constructor(private readonly sessionDir: string) {}

  /**
   * 按 Command output-store 的一致性约束执行 `writeLargeOutput` 状态变更。
   *
   * Args:
   * - `input`: `writeLargeOutput` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 Command output-store 的异步写入完成后兑现为声明结果。
   *
   * Throws:
   * - 当输入或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async writeLargeOutput(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly callId: string;
    readonly content: string;
    readonly preferredName: string;
  }): Promise<{ readonly outputPath: string }> {
    const dir = path.join(
      this.sessionDir,
      input.sessionId,
      'artifacts',
      input.runId,
      input.callId,
    );
    await mkdir(dir, { recursive: true });
    const outputPath = path.join(dir, safeFileName(input.preferredName));
    await writeFile(outputPath, input.content, 'utf8');
    return { outputPath };
  }
}

/**
 * 持久化超出模型预览限制的 Command 输出。
 *
 * Args:
 * - `input`: `persistLargeOutput` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - Promise 兑现为完整输出或带 artifact 路径的截断预览。
 */
export async function persistLargeOutput(input: {
  readonly output: string;
  readonly limits: CommandOutputLimits;
  readonly store: CommandOutputStore;
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly preferredName: string;
}): Promise<
  | { readonly output: string; readonly truncated: false }
  | {
      readonly output: string;
      readonly truncated: true;
      readonly outputPath: string;
    }
> {
  if (!shouldTruncate(input.output, input.limits)) {
    return { output: input.output, truncated: false };
  }
  const artifact = await input.store.writeLargeOutput({
    sessionId: input.sessionId,
    runId: input.runId,
    callId: input.callId,
    content: input.output,
    preferredName: input.preferredName,
  });
  return {
    output: previewOutput(input.output, input.limits),
    truncated: true,
    outputPath: artifact.outputPath,
  };
}

function shouldTruncate(value: string, limits: CommandOutputLimits): boolean {
  return (
    Buffer.byteLength(value, 'utf8') > limits.maxBytes ||
    value.split(/\r?\n/u).length > limits.maxLines
  );
}

/**
 * 生成头尾双端预览：头部占 {@link TRUNCATION_HEAD_RATIO}，其余额度留给尾部。
 * 测试与构建工具的失败摘要位于输出末尾，只留头部会让调用方看不到结论。
 */
function previewOutput(value: string, limits: CommandOutputLimits): string {
  const lines = value.split(/\r?\n/u);
  let preview = value;
  if (lines.length > limits.previewLines) {
    const headLines = Math.floor(
      limits.previewLines * TRUNCATION_HEAD_RATIO,
    );
    const tailLines = limits.previewLines - headLines;
    const omitted = lines.slice(headLines, lines.length - tailLines);
    const omittedBytes = Buffer.byteLength(omitted.join('\n'), 'utf8');
    preview = [
      ...lines.slice(0, headLines),
      `${truncationMarker(omittedBytes)} full output written to artifact ...`,
      ...lines.slice(lines.length - tailLines),
    ].join('\n');
  }
  return Buffer.byteLength(preview, 'utf8') <= limits.maxBytes
    ? preview
    : previewBytes(value, limits.maxBytes);
}

function previewBytes(value: string, maxBytes: number): string {
  const totalBytes = Buffer.byteLength(value, 'utf8');
  let omittedBytes = Math.max(0, totalBytes - maxBytes);
  let marker = byteMarker(omittedBytes);

  for (let pass = 0; pass < 3; pass += 1) {
    const detailBudget = maxBytes - Buffer.byteLength(marker, 'utf8');
    if (detailBudget <= 0) return sliceUtf8(value, maxBytes);
    const headBudget = Math.floor(detailBudget * TRUNCATION_HEAD_RATIO);
    const tailBudget = detailBudget - headBudget;
    const head = sliceUtf8(value, headBudget);
    const tail = sliceUtf8FromEnd(value, tailBudget);
    omittedBytes = Math.max(
      0,
      totalBytes -
        Buffer.byteLength(head, 'utf8') -
        Buffer.byteLength(tail, 'utf8'),
    );
    const nextMarker = byteMarker(omittedBytes);
    if (
      Buffer.byteLength(nextMarker, 'utf8') ===
      Buffer.byteLength(marker, 'utf8')
    ) {
      return `${head}${nextMarker}${tail}`;
    }
    marker = nextMarker;
  }

  const detailBudget = Math.max(
    0,
    maxBytes - Buffer.byteLength(marker, 'utf8'),
  );
  const headBudget = Math.floor(detailBudget * TRUNCATION_HEAD_RATIO);
  return `${sliceUtf8(value, headBudget)}${marker}${sliceUtf8FromEnd(
    value,
    detailBudget - headBudget,
  )}`;
}

function byteMarker(omittedBytes: number): string {
  return `\n${truncationMarker(omittedBytes)} full output written to artifact ...\n`;
}

function sliceUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && isUtf8ContinuationByte(bytes[end])) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function sliceUtf8FromEnd(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && isUtf8ContinuationByte(bytes[start])) {
    start += 1;
  }
  return bytes.subarray(start).toString('utf8');
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 120) || 'output.txt';
}
