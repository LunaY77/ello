import type {
  ModelMessage as AiModelMessage,
  LanguageModel,
  ToolChoice,
  ToolSet,
} from 'ai';
import type { z } from 'zod';

import type { AgentStreamEvent } from './events.js';

export type MaybePromise<T> = T | Promise<T>;

export type AgentMessage = AiModelMessage;
export type UserMessage = Extract<AiModelMessage, { role: 'user' }>;
export type AssistantMessage = Extract<AiModelMessage, { role: 'assistant' }>;

export type AgentInput =
  | string
  | AgentMessage[]
  | {
      prompt?: string;
      messages?: AgentMessage[];
      context?: Record<string, unknown>;
    };

export type AgentModel = string | LanguageModel;

export interface AgentRunOptions {
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

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: AgentError;
}

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

export interface ModelInput {
  readonly system?: string;
  readonly messages: AgentMessage[];
  readonly tools: AgentToolSet;
  readonly activeTools?: readonly string[];
  readonly toolChoice?: AgentToolChoice;
  readonly providerOptions?: Record<string, unknown>;
  readonly diagnostics?: ModelInputDiagnostics;
}

export interface ModelInputDiagnostics {
  readonly systemSections: number;
  readonly messageCount: number;
  readonly estimatedInputTokens?: number;
  readonly activeTools?: readonly string[];
  readonly hasProviderOptions: boolean;
  readonly appliedMessageTransforms: readonly string[];
}

export type SystemSection<TContext = unknown> = (
  run: AgentRunContext<TContext>,
) => MaybePromise<string | null | undefined>;

export type MessageTransform<TContext = unknown> = (
  messages: readonly AgentMessage[],
  run: AgentRunContext<TContext>,
) => MaybePromise<readonly AgentMessage[]>;

export type ProviderOptionsResolver<TContext = unknown> = (
  run: AgentRunContext<TContext>,
) => MaybePromise<Record<string, unknown> | null | undefined>;

export type PrepareModelInput<TContext = unknown> = (
  input: ModelInput,
  run: AgentRunContext<TContext>,
) => MaybePromise<ModelInput>;

export interface AgentModelRequest {
  readonly runId: string;
  readonly model: AgentModel;
  readonly system?: string;
  readonly messages: AgentMessage[];
  readonly tools: ToolSet;
  readonly activeTools?: readonly string[];
  readonly toolChoice?: AgentToolChoice;
  readonly providerOptions?: Record<string, unknown>;
  readonly modelSettings: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export interface AgentModelResponse {
  readonly text: string;
  readonly messages: AgentMessage[];
  readonly newMessages?: AgentMessage[];
  readonly toolCalls?: AgentToolCall[];
  readonly toolResults?: unknown[];
  readonly usage: AgentUsage;
  readonly finishReason: AgentFinishReason;
  readonly provider: unknown;
}

export type AgentModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'final'; response: AgentModelResponse };

export interface ModelAdapter {
  generate(request: AgentModelRequest): Promise<AgentModelResponse>;
  stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent>;
}

export interface AgentError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: unknown;
}

export interface AgentApprovalRequest {
  readonly id: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
  readonly reason?: string;
}

export type AgentApprovalDecision = 'auto' | 'required' | 'denied';
export type AgentApprovalPolicy<TInput = unknown> = (
  input: TInput,
  ctx: AgentToolContext,
) => MaybePromise<AgentApprovalDecision>;

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<TInput>;
  execute(input: TInput, ctx: AgentToolContext): MaybePromise<TOutput>;
  approval?(
    input: TInput,
    ctx: AgentToolContext,
  ): MaybePromise<AgentApprovalDecision>;
  readonly inherit?: boolean;
}

export type AnyAgentTool = AgentTool<unknown, unknown>;

export interface AgentToolContext {
  readonly runId: string;
  readonly environment: AgentEnvironment;
  readonly metadata: Record<string, unknown>;
}

export interface AgentSetupContext {
  readonly agentId: string;
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
  readonly state: AgentRunState;
  readonly trace: AgentTrace;
}

export type AgentContext = AgentRunContext;

export interface AgentRunState {
  readonly messages: AgentMessage[];
  readonly budget: Record<string, unknown>;
  readonly turn: number;
  readonly queueDiagnostics: QueueDrainDiagnostic[];
}

export interface AgentTrace {
  readonly events: AgentStreamEvent[];
  readonly metadata: Record<string, unknown>;
}

export type AgentToolSet = ToolSet;
export type AgentToolChoice = ToolChoice<ToolSet>;

export interface SessionStore {
  load(sessionId: string): Promise<AgentMessage[]>;
  append(
    sessionId: string,
    messages: AgentMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  appendEvent?(sessionId: string, event: AgentStreamEvent): Promise<void>;
  compact?(
    sessionId: string,
    result: SessionCompactionReport,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  replace?(
    sessionId: string,
    messages: AgentMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

export interface AgentMemory<TContext = unknown> {
  readonly retrievePolicy?: MemoryRetrievePolicy;
  retrieve(
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<readonly AgentMemoryItem[]>;
  observe?(
    event: MemoryObserveEvent,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  compact?(ctx: AgentRunContext<TContext>): MaybePromise<MemoryCompactResult>;
}

export interface AgentMemoryItem {
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
}

export type MemoryRetrievePolicy =
  | 'once-per-run'
  | 'once-per-turn'
  | 'on-context-change';

export interface MemoryObserveEvent {
  readonly type: 'run.completed' | 'run.failed';
  readonly result?: AgentRunResult;
  readonly error?: AgentError;
  readonly diagnostics?: AgentRunDiagnostics;
}

export interface MemoryCompactResult {
  readonly changed: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentObserver<TContext = unknown> {
  onRunStarted?(
    event: { readonly runId: string },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onTurnStarted?(
    event: { readonly runId: string; readonly turnIndex: number },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onToolScheduled?(
    event: AgentToolCall,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onToolApprovalRequired?(
    event: DeferredApprovalItem,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onToolCompleted?(
    event: AgentToolCall,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onRunCompleted?(
    result: AgentRunResult,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onRunFailed?(
    event: { readonly error: AgentError },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
}

export interface SessionCompactor<TContext = unknown> {
  readonly name: string;
  maybeCompact(
    sessionId: string,
    store: SessionStore,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<SessionCompactionReport | null>;
}

export interface SessionCompactionReport {
  readonly compactor: string;
  readonly beforeMessageCount: number;
  readonly afterMessageCount: number;
  readonly metadata?: Record<string, unknown>;
}

export type AgentMessageQueueMode = 'all' | 'one-at-a-time';

export interface AgentMessageQueue<T = AgentMessage> {
  readonly mode: AgentMessageQueueMode;
  readonly size: number;
  readonly hasItems: boolean;
  push(item: T): void;
  drain(): T[];
  clear(): void;
}

export type AgentRunControlStatus =
  | 'running'
  | 'waiting_approval'
  | 'interrupted'
  | 'completed'
  | 'failed';

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

export interface AgentRunDiagnostics {
  readonly modelInput?: ModelInputDiagnostics;
  readonly turns?: AgentTurnDiagnostics[];
  readonly queueDrains: QueueDrainDiagnostic[];
  readonly pendingCount: number;
  readonly resumeSource?: 'options.resume';
  readonly compactions?: SessionCompactionReport[];
  readonly subagents?: SubagentRunSummary[];
}

export interface AgentTurnDiagnostics {
  readonly turn: number;
  readonly modelInput: ModelInputDiagnostics;
  readonly queueDrains: QueueDrainDiagnostic[];
  readonly finishReason: AgentFinishReason;
  readonly newMessageCount: number;
}

export interface AgentSkill {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tools?: readonly AnyAgentTool[];
  readonly metadata?: Record<string, unknown>;
}

export interface SubagentDefinition {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly inheritTools?: boolean;
  readonly tools?: readonly AnyAgentTool[];
  readonly metadata?: Record<string, unknown>;
}

export interface SubagentRunSummary {
  readonly name: string;
  readonly runId: string;
  readonly usage: AgentUsage;
  readonly finishReason: AgentFinishReason;
}

export interface AgentFileSystem {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  getContextInstructions?(): MaybePromise<string | null>;
  close?(): MaybePromise<void>;
}

export interface AgentShell {
  run(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    },
  ): Promise<AgentShellResult>;
  getContextInstructions?(): MaybePromise<string | null>;
  close?(): MaybePromise<void>;
}

export interface AgentShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AgentEnvironment {
  readonly fileSystem?: AgentFileSystem;
  readonly files?: AgentFileSystem;
  readonly shell?: AgentShell;
  readonly resources?: AgentResourceRegistry;
  setup?(ctx: AgentRunContext): MaybePromise<void>;
  getContextInstructions?(ctx: AgentRunContext): MaybePromise<string | null>;
  getInstructions?(): MaybePromise<string | null>;
  onEvent?(event: AgentStreamEvent, ctx: AgentRunContext): MaybePromise<void>;
  close?(): MaybePromise<void>;
}

export interface AgentResource {
  setup?(): MaybePromise<void>;
  close?(): MaybePromise<void>;
  getContextInstructions?(): MaybePromise<string | null>;
}

export type AgentResourceFactory = (
  environment: AgentEnvironment,
) => MaybePromise<AgentResource>;

export interface AgentResourceRegistry {
  bind?(environment: AgentEnvironment): void;
  setupAll?(): MaybePromise<void>;
  register(key: string, resource: AgentResource): void;
  registerFactory(key: string, factory: AgentResourceFactory): void;
  get(key: string): AgentResource | undefined;
  getOrCreate(key: string): Promise<AgentResource>;
  keys(): string[];
  getContextInstructions?(): MaybePromise<string | null>;
  closeAll?(): MaybePromise<void>;
}

export interface CreateAgentOptions<TContext = unknown> {
  readonly model: AgentModel;
  readonly name?: string;
  readonly instructions?: string;
  readonly modelSettings?: Record<string, unknown>;
  readonly modelAdapter?: ModelAdapter;
  readonly environment?: AgentEnvironment;
  readonly tools?: readonly AnyAgentTool[];
  readonly session?: SessionStore;
  readonly memory?: AgentMemory<TContext>;
  readonly observers?: readonly AgentObserver<TContext>[];
  readonly compactor?: SessionCompactor<TContext>;
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
