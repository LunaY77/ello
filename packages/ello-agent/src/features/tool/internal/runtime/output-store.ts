/**
 * 本文件负责 tool feature 的“output-store”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ToolOutputLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly previewLines: number;
}

export interface ToolOutputStore {
  /**
   * 按 工具 `output-store` 模块 的一致性约束执行 `writeLargeOutput` 状态变更。
   *
   * Args:
   * - `input`: `writeLargeOutput` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 工具 `output-store` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 工具 `output-store` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  writeLargeOutput(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly callId: string;
    readonly content: string;
    readonly preferredName: string;
  }): Promise<{ readonly outputPath: string }>;
}

export class SessionToolOutputStore implements ToolOutputStore {
  /**
   * 创建 `SessionToolOutputStore`，由该实例独占 工具 `output-store` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `sessionDir`: `constructor SessionToolOutputStore` 所需的业务值；函数按声明读取，不补造缺失内容。
   */
  constructor(private readonly sessionDir: string) {}

  /**
   * 按 工具 `output-store` 模块 的一致性约束执行 `writeLargeOutput` 状态变更。
   *
   * Args:
   * - `input`: `writeLargeOutput` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 工具 `output-store` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 工具 `output-store` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
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
 * 执行 工具 `output-store` 模块 定义的 `persistLargeOutput` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `input`: `persistLargeOutput` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - Promise 在 工具 `output-store` 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export async function persistLargeOutput(input: {
  readonly output: string;
  readonly limits: ToolOutputLimits;
  readonly store: ToolOutputStore;
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
    output: previewOutput(input.output, input.limits.previewLines),
    truncated: true,
    outputPath: artifact.outputPath,
  };
}

function shouldTruncate(value: string, limits: ToolOutputLimits): boolean {
  return (
    Buffer.byteLength(value, 'utf8') > limits.maxBytes ||
    value.split(/\r?\n/u).length > limits.maxLines
  );
}

function previewOutput(value: string, previewLines: number): string {
  const lines = value.split(/\r?\n/u);
  return `${lines.slice(0, previewLines).join('\n')}\n... truncated; full output written to artifact ...`;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 120) || 'output.txt';
}
