import type {
  AgentApprovalDecision,
  AgentToolContext,
  MaybePromise,
} from '@ello/agent';
import type { z } from 'zod';

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
  readonly diff?: string;
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
  readonly input: z.ZodType<TInput>;
  execute(
    input: TInput,
    ctx: CodingToolContext,
  ): MaybePromise<CodingToolResult>;
  approval?(
    input: TInput,
    ctx: CodingToolContext,
  ): MaybePromise<AgentApprovalDecision>;
}

export type CodingTool<TInput = unknown> = DefineCodingToolOptions<TInput>;

export type AnyCodingTool = {
  readonly name: string;
  readonly description: string;
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

export function defineCodingTool<TInput>(
  options: DefineCodingToolOptions<TInput>,
): CodingTool<TInput> {
  return options;
}

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
