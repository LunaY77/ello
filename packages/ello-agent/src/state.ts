import { Buffer } from 'node:buffer';

import type { ModelMessage } from 'ai';
import { z } from 'zod';

/** 单个待审批工具请求。 */
export interface DeferredToolApprovalRequest {
  toolCallId: string;
  toolName: string;
  input?: unknown;
}

/** 单个待外部执行工具请求。 */
export interface DeferredToolCallRequest {
  toolCallId: string;
  toolName: string;
  input?: unknown;
}

/** 可序列化的 deferred tool 请求集合。 */
export interface DeferredToolRequests {
  approvals: DeferredToolApprovalRequest[];
  calls: DeferredToolCallRequest[];
}

/** 单个工具审批结果。 */
export type DeferredToolApprovalResult =
  | boolean
  | {
      approved: boolean;
      reason?: string;
    };

/** resume 时提供的 deferred tool 结果。 */
export interface DeferredToolResults {
  approvals: Record<string, DeferredToolApprovalResult>;
  calls: Record<string, unknown>;
}

/** RunState 构造参数。 */
export interface RunStateOptions {
  messages: ModelMessage[];
  pendingRequests?: DeferredToolRequests | null;
  runId?: string | null;
}

/** fromRunResult 兼容的最小 run result 形态。 */
export interface RunResultLike {
  output?: unknown;
  allMessages?: () => ModelMessage[];
  all_messages?: () => ModelMessage[];
  messages?: ModelMessage[];
}

const DeferredToolApprovalRequestSchema = z
  .object({
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown().optional(),
  })
  .passthrough();

const DeferredToolCallRequestSchema = z
  .object({
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown().optional(),
  })
  .passthrough();

const DeferredToolRequestsSchema = z.object({
  approvals: z.array(DeferredToolApprovalRequestSchema).default([]),
  calls: z.array(DeferredToolCallRequestSchema).default([]),
});

const RunStateEnvelopeSchema = z.object({
  messages: z.array(z.unknown()),
  pendingRequests: DeferredToolRequestsSchema.nullable().optional(),
  pending_requests: DeferredToolRequestsSchema.nullable().optional(),
  runId: z.string().nullable().optional(),
  run_id: z.string().nullable().optional(),
});

/**
 * 可序列化的 agent 运行状态。
 *
 * 包含消息历史和待审批/待执行的工具请求, 支持 JSON 序列化和反序列化,
 * 用于跨进程 pause/resume。
 */
export class RunState {
  readonly messages: ModelMessage[];
  readonly pendingRequests: DeferredToolRequests | null;
  readonly runId: string | null;

  constructor(options: RunStateOptions) {
    this.messages = options.messages;
    this.pendingRequests = normalizeDeferredToolRequests(
      options.pendingRequests ?? null,
    );
    this.runId = options.runId ?? null;
  }

  /** 是否有待审批的工具调用。 */
  get needsApproval(): boolean {
    return (this.pendingRequests?.approvals.length ?? 0) > 0;
  }

  /** 是否有待外部执行的工具调用。 */
  get hasDeferredCalls(): boolean {
    return (this.pendingRequests?.calls.length ?? 0) > 0;
  }

  /**
   * 构建用于 resume 的 DeferredToolResults。
   *
   * Args:
   *   approveAll: 是否批准所有待审批请求。
   *   approvals: 按 toolCallId 指定审批结果。
   *   calls: 按 toolCallId 指定外部执行结果。
   */
  buildResumeResults(
    options: {
      approveAll?: boolean;
      approvals?: Record<string, DeferredToolApprovalResult>;
      calls?: Record<string, unknown>;
    } = {},
  ): DeferredToolResults {
    if (this.pendingRequests === null) {
      throw new Error('No pending requests to build results from');
    }

    const approvals: Record<string, DeferredToolApprovalResult> = {
      ...(options.approvals ?? {}),
    };
    if (options.approveAll === true) {
      for (const request of this.pendingRequests.approvals) {
        approvals[request.toolCallId] = true;
      }
    }

    return {
      approvals,
      calls: { ...(options.calls ?? {}) },
    };
  }

  /**
   * 序列化为 JSON bytes。
   *
   * Returns:
   *   UTF-8 编码的 JSON bytes。
   */
  saveJson(): Uint8Array {
    const envelope = {
      messages: this.messages,
      pendingRequests: this.pendingRequests,
      runId: this.runId,
    };
    return Buffer.from(JSON.stringify(envelope), 'utf8');
  }

  /** 序列化为 JSON 字符串。 */
  toJson(): string {
    return Buffer.from(this.saveJson()).toString('utf8');
  }

  /**
   * 从 JSON bytes 或字符串反序列化。
   *
   * Args:
   *   data: saveJson() 或 toJson() 输出的数据。
   */
  static loadJson(data: Uint8Array | string): RunState {
    const raw =
      typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    const envelope = RunStateEnvelopeSchema.parse(JSON.parse(raw));
    return new RunState({
      messages: envelope.messages as ModelMessage[],
      pendingRequests:
        envelope.pendingRequests ?? envelope.pending_requests ?? null,
      runId: envelope.runId ?? envelope.run_id ?? null,
    });
  }

  /**
   * 从 agent run result 构建 RunState。
   *
   * Args:
   *   result: run() 返回的结果对象。
   *   runId: 可选运行 ID。
   */
  static fromRunResult(result: RunResultLike, runId?: string | null): RunState {
    const output = result.output;
    const pendingRequests = isDeferredToolRequests(output) ? output : null;
    return new RunState({
      messages: extractMessages(result),
      pendingRequests,
      runId: runId ?? null,
    });
  }
}

/** 判断对象是否为 deferred tool 请求集合。 */
export function isDeferredToolRequests(
  value: unknown,
): value is DeferredToolRequests {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<DeferredToolRequests>;
  return Array.isArray(candidate.approvals) && Array.isArray(candidate.calls);
}

function normalizeDeferredToolRequests(
  value: DeferredToolRequests | null,
): DeferredToolRequests | null {
  if (value === null) {
    return null;
  }
  return {
    approvals: [...value.approvals],
    calls: [...value.calls],
  };
}

function extractMessages(result: RunResultLike): ModelMessage[] {
  if (typeof result.allMessages === 'function') {
    return [...result.allMessages()];
  }
  if (typeof result.all_messages === 'function') {
    return [...result.all_messages()];
  }
  return [...(result.messages ?? [])];
}
