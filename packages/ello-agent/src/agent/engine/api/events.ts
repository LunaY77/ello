import type {
  AgentError,
  AgentFinishReason,
  AgentUsage,
  DeferredApprovalItem,
  DeferredToolCallItem,
} from './agent.js';
import type {
  AgentMessage,
  AgentModelRequest,
  AgentModelResponse,
} from './model.js';
import type { AgentApprovalRequest } from './tool.js';

export interface AgentEventMetadata {
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: string;
}

export interface ModelCallIdentity {
  readonly runId: string;
  readonly turnIndex: number;
  readonly modelCallId: string;
  readonly provider: string;
  readonly model: string;
}

export interface ModelCallDiagnostics {
  readonly systemFingerprint: string;
  readonly toolsetFingerprint: string;
  readonly messagePrefixFingerprint: string;
  readonly compactionBoundary: boolean;
}

export interface RunCompletedEvent extends AgentEventMetadata {
  readonly type: 'run.completed';
  readonly finishReason: AgentFinishReason;
  readonly usage: AgentUsage;
}

export type EngineEvent =
  | (AgentEventMetadata & { readonly type: 'run.started' })
  | (AgentEventMetadata & {
      readonly type: 'turn.started';
      readonly turnIndex: number;
    })
  | (AgentEventMetadata & {
      readonly type: 'turn.completed';
      readonly turnIndex: number;
    })
  | (AgentEventMetadata & {
      readonly type: 'queue.drained';
      readonly queue: string;
      readonly count: number;
    })
  | (AgentEventMetadata & {
      readonly type: 'message.started';
      readonly turnIndex: number;
      readonly messageId: string;
      readonly role: 'assistant';
    })
  | (AgentEventMetadata & {
      readonly type: 'message.delta';
      readonly turnIndex: number;
      readonly messageId: string;
      readonly text: string;
    })
  | (AgentEventMetadata & {
      readonly type: 'model.started';
      readonly identity: ModelCallIdentity;
      readonly request: AgentModelRequest;
      readonly diagnostics: ModelCallDiagnostics;
    })
  | (AgentEventMetadata & {
      readonly type: 'model.first_token';
      readonly identity: ModelCallIdentity;
    })
  | (AgentEventMetadata & {
      readonly type: 'model.completed';
      readonly identity: ModelCallIdentity;
      readonly response: AgentModelResponse;
      readonly diagnostics: ModelCallDiagnostics;
      readonly startedAt: string;
      readonly firstTokenAt?: string;
    })
  | (AgentEventMetadata & {
      readonly type: 'model.failed';
      readonly identity: ModelCallIdentity;
      readonly error: AgentError;
      readonly diagnostics: ModelCallDiagnostics;
      readonly startedAt: string;
    })
  | (AgentEventMetadata & {
      readonly type: 'tool.started';
      readonly turnIndex: number;
      readonly toolCallId: string;
      readonly name: string;
      readonly input: unknown;
    })
  | (AgentEventMetadata & {
      readonly type: 'tool.approval_requested';
      readonly turnIndex: number;
      readonly request: AgentApprovalRequest;
    })
  | (AgentEventMetadata & {
      readonly type: 'approval.required';
      readonly item: DeferredApprovalItem;
    })
  | (AgentEventMetadata & {
      readonly type: 'tool.deferred';
      readonly item: DeferredToolCallItem;
    })
  | (AgentEventMetadata & {
      readonly type: 'tool.completed';
      readonly turnIndex: number;
      readonly toolCallId: string;
      readonly output: unknown;
    })
  | (AgentEventMetadata & {
      readonly type: 'tool.failed';
      readonly turnIndex: number;
      readonly toolCallId: string;
      readonly error: AgentError;
    })
  | (AgentEventMetadata & {
      readonly type: 'context.compaction';
      readonly beforeMessageCount: number;
      readonly afterMessageCount: number;
      readonly compactor: string;
      readonly metadata?: Record<string, unknown>;
    })
  | (AgentEventMetadata & {
      readonly type: 'run.interrupted';
      readonly messages: AgentMessage[];
    })
  | RunCompletedEvent
  | (AgentEventMetadata & {
      readonly type: 'run.failed';
      readonly error: AgentError;
      readonly partialMessages: AgentMessage[];
    });

type StripMetadata<T> = T extends unknown
  ? Omit<T, keyof AgentEventMetadata> & { readonly runId?: string }
  : never;

/** 内核事件发射端的输入；运行身份、时间和序列号由 dispatcher 统一注入。 */
export type AgentEventInput = StripMetadata<EngineEvent>;
