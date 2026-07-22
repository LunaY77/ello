/**
 * 本文件负责 tool feature 的“coding-tool”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { z } from 'zod';

import type {
  AgentApprovalDecision,
  AgentToolContext,
  AgentToolDiscovery,
  MaybePromise,
} from '../../../agent/engine/index.js';
import type { FileChange } from '../file-change.js';

export type ToolMetadataKind =
  | 'read'
  | 'search'
  | 'edit'
  | 'shell'
  | 'network'
  | 'task'
  | 'workspace'
  | 'generic';

export interface ToolMetadata {
  /**
   * 工具元数据服务于 TUI、权限弹窗和日志展示，不是模型语义判断的来源。
   * 模型应该只依赖工具描述、输入 schema 和 output 文本继续推理。
   */
  readonly kind: ToolMetadataKind;
  readonly summary?: string;
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly command?: string;
  readonly cwd?: string;
  readonly url?: string;
  readonly domain?: string;
  readonly fileChanges?: readonly FileChange[];
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly truncated?: boolean;
  readonly outputPath?: string;
  readonly [key: string]: unknown;
}

export interface ToolAttachment {
  readonly type: 'text' | 'image' | 'pdf' | 'binary';
  readonly mime: string;
  readonly path?: string;
  readonly name?: string;
  readonly bytes?: number;
  readonly content?: string;
}

export interface CodingToolResult {
  readonly kind: 'coding-tool-result';
  readonly title: string;
  readonly output: string;
  readonly metadata: ToolMetadata;
  readonly attachments?: readonly ToolAttachment[];
}

export interface CodingPermissionRequestDraft {
  readonly reason?: string;
  readonly metadata?: ToolMetadata;
}

export interface CodingToolContext {
  readonly cwd: string;
  readonly allowedPaths: readonly string[];
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly abortSignal?: AbortSignal;
  readonly agent: AgentToolContext;
}

export interface DefineCodingToolOptions<TInput> {
  readonly name: string;
  readonly description: string;
  readonly discovery: AgentToolDiscovery;
  readonly input: z.ZodType<TInput>;
  /**
   * 在 工具 `coding-tool` 模块 中执行 `execute` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `input`: `execute` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `execute` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 工具 `coding-tool` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  execute(
    input: TInput,
    ctx: CodingToolContext,
  ): MaybePromise<CodingToolResult>;
  /**
   * 执行 工具 `coding-tool` 模块 定义的 `approval` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `input`: `approval` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `approval` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  approval?(
    input: TInput,
    ctx: CodingToolContext,
  ): MaybePromise<AgentApprovalDecision>;
}

export type CodingTool<TInput = unknown> = DefineCodingToolOptions<TInput>;

export type AnyCodingTool = {
  readonly name: string;
  readonly description: string;
  readonly discovery: AgentToolDiscovery;
  readonly input: z.ZodType<unknown>;
  execute(
    input: unknown,
    ctx: CodingToolContext,
  ): MaybePromise<CodingToolResult>;
  approval?(
    input: unknown,
    ctx: CodingToolContext,
  ): MaybePromise<AgentApprovalDecision>;
};

/**
 * 执行 工具 `coding-tool` 模块 定义的 `defineCodingTool` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `options`: 仅作用于 `defineCodingTool` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回 `defineCodingTool` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function defineCodingTool<TInput>(
  options: DefineCodingToolOptions<TInput>,
): AnyCodingTool {
  const approval = options.approval;
  return {
    name: options.name,
    description: options.description,
    discovery: options.discovery,
    input: options.input,
    execute: (input, ctx) => options.execute(options.input.parse(input), ctx),
    ...(approval === undefined
      ? {}
      : {
          approval: (input: unknown, ctx: CodingToolContext) =>
            approval(options.input.parse(input), ctx),
        }),
  };
}

/**
 * 构造 工具 `coding-tool` 模块 中的 `createCodingToolResult` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `input`: `createCodingToolResult` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `createCodingToolResult` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `coding-tool` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createCodingToolResult(input: {
  readonly title: string;
  readonly output: string;
  readonly metadata: ToolMetadata;
  readonly attachments?: readonly ToolAttachment[];
}): CodingToolResult {
  return {
    kind: 'coding-tool-result',
    title: input.title,
    output: input.output,
    metadata: input.metadata,
    ...(input.attachments !== undefined
      ? { attachments: input.attachments }
      : {}),
  };
}
