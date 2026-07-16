import type { AgentEnvironment } from './environment.js';
import type { AgentStreamEvent } from './events.js';
import type {
  AgentMessage,
  AgentModel,
  MessageTransform,
  ModelAdapter,
  ModelInputDiagnostics,
  PrepareModelInput,
  ProviderOptionsResolver,
  SystemSection,
} from './model.js';
import type { AgentObserver } from './observer.js';
import type {
  AgentEventRecorder,
  CompactionPort,
  TranscriptStore,
} from './persistence.js';
import type { AgentToolCall, AnyAgentTool } from './tool.js';

export type AgentInput =
  | string
  | AgentMessage[]
  | {
      prompt?: string;
      messages?: AgentMessage[];
      context?: Record<string, unknown>;
    };

export interface AgentRunOptions {
  readonly runId?: string;
  readonly modelSettings?: Record<string, unknown>;
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Record<string, unknown>;
  readonly messages?: AgentMessage[];
  readonly sessionId?: string;
  readonly context?: unknown;
  readonly resume?: DeferredRunResults;
}

export interface Agent {
  run(input: AgentInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  stream(input: AgentInput, options?: AgentRunOptions): AgentStream;
  resume(deferred: DeferredRunResults, options?: AgentRunOptions): AgentStream;
  close(): Promise<void>;
}

export interface AgentStream extends AsyncIterable<AgentStreamEvent> {
  readonly final: Promise<AgentRunResult>;
  steer(message: AgentMessage): void;
  abort(reason?: unknown): void;
}

export interface AgentUsage {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly toolCalls: number;
}

export type AgentFinishReason =
  | 'stop'
  | 'length'
  | 'tool-calls'
  | 'approval-required'
  | 'interrupted'
  | 'no-progress'
  | 'content-filter'
  | 'error'
  | 'unknown';

export interface AgentRunResult {
  readonly id: string;
  readonly text?: string;
  readonly output: string;
  readonly messages: AgentMessage[];
  readonly usage: AgentUsage;
  readonly finishReason: AgentFinishReason;
  readonly toolCalls: AgentToolCall[];
  readonly pending?: DeferredRunItem[];
  readonly diagnostics?: AgentRunDiagnostics;
  readonly metadata: Record<string, unknown>;
}

export interface AgentError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: unknown;
}

export interface AgentRunContext<TContext = unknown> {
  readonly runId: string;
  readonly agentName: string;
  readonly sessionId?: string;
  readonly input: AgentInput;
  readonly context: TContext;
  readonly options: AgentRunOptions;
  readonly environment: AgentEnvironment;
  readonly metadata: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export type AgentContext = AgentRunContext;

export type DeferredRunItem =
  | DeferredApprovalItem
  | DeferredToolCallItem
  | InterruptedRunItem;

export interface DeferredApprovalItem {
  readonly kind: 'approval';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input?: unknown;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface DeferredToolCallItem {
  readonly kind: 'tool-call';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input?: unknown;
}

export interface InterruptedRunItem {
  readonly kind: 'interrupted';
  readonly messages: AgentMessage[];
  readonly reason?: string;
}

export interface DeferredRunResults {
  readonly deferred?: readonly DeferredRunItem[];
  readonly approvals?: Record<
    string,
    boolean | { readonly approved: boolean; readonly reason?: string }
  >;
  readonly toolResults?: Record<string, unknown>;
}

export interface QueueDrainDiagnostic {
  readonly queue: string;
  readonly count: number;
}

export interface SessionCompactionReport {
  readonly compactor: string;
  readonly beforeMessageCount: number;
  readonly afterMessageCount: number;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentRunDiagnostics {
  readonly modelInput?: ModelInputDiagnostics;
  readonly turns?: AgentTurnDiagnostics[];
  readonly queueDrains: QueueDrainDiagnostic[];
  readonly pendingCount: number;
  readonly resumeSource?: 'options.resume';
  readonly compactions?: SessionCompactionReport[];
}

export interface AgentTurnDiagnostics {
  readonly turn: number;
  readonly modelInput: ModelInputDiagnostics;
  readonly queueDrains: QueueDrainDiagnostic[];
  readonly finishReason: AgentFinishReason;
  readonly newMessageCount: number;
}

export interface CreateAgentOptions<TContext = unknown> {
  readonly model: AgentModel;
  readonly name?: string;
  readonly instructions?: string;
  readonly modelSettings?: Record<string, unknown>;
  readonly modelAdapter?: ModelAdapter;
  readonly environment?: AgentEnvironment;
  /** 完整执行注册表；超过直连上限时同时包含目标工具和路由工具。 */
  readonly executionTools: readonly AnyAgentTool[];
  /** 模型可见工具集；由产品层决定直接暴露或切换为 tool_search/call_tool。 */
  readonly modelTools: readonly AnyAgentTool[];
  readonly transcript?: TranscriptStore;
  readonly observers?: readonly AgentObserver<TContext>[];
  readonly eventRecorder?: AgentEventRecorder<TContext>;
  readonly stream?: { readonly maxBufferedEvents: number };
  readonly compaction?: CompactionPort<TContext>;
  readonly metadata?: Record<string, unknown>;
  readonly sessionWindow?: { readonly maxMessages: number };
  readonly modelInputBudget?: {
    readonly maxInputTokens: number;
    readonly reservedOutputTokens?: number;
  };
  readonly modelInput?: {
    readonly systemSections?: readonly SystemSection<TContext>[];
    readonly messageTransforms?: readonly MessageTransform<TContext>[];
    readonly providerOptions?: ProviderOptionsResolver<TContext>;
    readonly prepare?: PrepareModelInput<TContext>;
  };
}
