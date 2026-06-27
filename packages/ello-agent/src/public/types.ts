import type {
  ModelMessage as AiModelMessage,
  LanguageModel,
  ToolChoice,
  ToolSet,
} from 'ai';
import type { z } from 'zod';

import type { AgentStreamEvent } from './events.js';

/**
 * 可能同步或异步返回的值。
 *
 * Args:
 *   T: 实际业务返回类型。
 *
 * Returns:
 *   T 或 Promise<T>，用于让工具、扩展和 adapter 同时支持同步/异步实现。
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * ello-agent 对外暴露的消息语义名。
 *
 * @example
 * ```ts
 * const messages: AgentMessage[] = [
 *   { role: 'user', content: 'Summarize this file.' },
 * ];
 * ```
 */
export type AgentMessage = AiModelMessage;
export type UserMessage = Extract<AiModelMessage, { role: 'user' }>;
export type AssistantMessage = Extract<AiModelMessage, { role: 'assistant' }>;

/**
 * Agent 调用输入。
 *
 * Args:
 *   string: 最常用的 prompt 输入，会转换为一条 user message。
 *   AgentMessage[]: 已经规范化的消息历史。
 *   object.prompt: 单次 user prompt。
 *   object.messages: 调用方提供的消息历史。
 *   object.context: 产品层可传入的额外上下文，目前只作为输入载荷保留。
 *
 * @example
 * ```ts
 * await agent.run('Explain the current diff.');
 * await agent.run([{ role: 'user', content: 'List files.' }]);
 * await agent.run({ prompt: 'Review this module.', context: { cwd } });
 * ```
 */
export type AgentInput =
  | string
  | AgentMessage[]
  | {
      prompt?: string;
      messages?: AgentMessage[];
      context?: Record<string, unknown>;
    };

/**
 * Agent 模型配置。
 *
 * Args:
 *   string: provider:model 形式，例如 `openai:gpt-4.1-mini`。
 *   LanguageModel: Vercel AI SDK provider 创建的 model 实例。
 */
export type AgentModel = string | LanguageModel;

/**
 * 单次 run 的可选项。
 *
 * Args:
 *   modelSettings: 透传给模型 adapter 的采样、温度等模型级设置。
 *   maxTurns: 预留给多 turn agent loop 的停止条件。
 *   signal: 外部取消信号。
 *   metadata: 本次 run 的产品层元数据，会合并到 AgentRunResult.metadata。
 *   messages: 额外追加到本次输入后的消息。
 */
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

/**
 * Agent 生命周期入口。
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   model: 'openai:gpt-4.1-mini',
 *   instructions: 'You are concise.',
 * });
 *
 * const result = await agent.run('Say hello.');
 * console.log(result.output);
 * await agent.close();
 * ```
 */
export interface Agent {
  /**
   * 执行一次非流式调用。
   *
   * Args:
   *   input: prompt、消息数组或结构化 AgentInput。
   *   options: 本次调用的模型设置、metadata 和取消信号。
   *
   * Returns:
   *   统一的 AgentRunResult，与 stream.final 的类型完全一致。
   */
  run(input: AgentInput, options?: AgentRunOptions): Promise<AgentRunResult>;

  /**
   * 执行一次流式调用。
   *
   * Args:
   *   input: prompt、消息数组或结构化 AgentInput。
   *   options: 本次调用的模型设置、metadata 和取消信号。
   *
   * Returns:
   *   可异步迭代的 AgentStream；最终结果通过 await stream.final 获取。
   */
  stream(input: AgentInput, options?: AgentRunOptions): AgentStream;

  /**
   * 释放 agent 持有的环境与扩展资源。
   *
   * Returns:
   *   资源释放完成后 resolve。
   */
  close(): Promise<void>;
}

/**
 * 可 await final 的流式协议。
 *
 * @example
 * ```ts
 * const stream = agent.stream('Write a changelog.');
 * for await (const event of stream) {
 *   if (event.type === 'message.delta') process.stdout.write(event.text);
 * }
 * const final = await stream.final;
 * ```
 */
export interface AgentStream extends AsyncIterable<AgentStreamEvent> {
  /** 与 agent.run() 相同形状的最终结果。 */
  readonly final: Promise<AgentRunResult>;

  /**
   * 中断当前流。
   *
   * Args:
   *   reason: 可选中断原因，会用于 reject final promise。
   */
  abort(reason?: unknown): void;
}

/** Agent 累计 usage，用于 UI、日志和成本统计。 */
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

/**
 * Agent 工具调用摘要。
 *
 * 每个工具调用都会记录输入、输出或错误，方便产品层渲染工具卡片、
 * 持久化审计轨迹或做 observability 上报。
 */
export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: AgentError;
}

/**
 * run() 与 stream.final 的统一结果类型。
 *
 * Returns:
 *   id: 本次 run 的唯一 ID。
 *   output: assistant 最终文本输出。
 *   messages: 本次 run 结束后的消息历史。
 *   usage: 模型与工具使用量汇总。
 *   finishReason: 模型停止原因。
 *   toolCalls: 工具调用摘要。
 *   metadata: provider 原始响应和调用方元数据。
 */
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

/**
 * 模型调用请求。
 */
export interface AgentModelRequest {
  readonly runId: string;
  readonly model: AgentModel;
  readonly system?: string;
  readonly messages: AgentMessage[];
  readonly tools: ToolSet;
  readonly activeTools?: string[];
  readonly toolChoice?: AgentToolChoice;
  readonly providerOptions?: Record<string, unknown>;
  readonly modelSettings: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

/** 模型调用响应。 */
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

/** 模型流式事件。 */
export type AgentModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'final'; response: AgentModelResponse };

/**
 * 可替换模型 adapter。
 *
 * @example
 * ```ts
 * const adapter: ModelAdapter = {
 *   async generate(request) {
 *     return {
 *       text: 'mock',
 *       messages: [...request.messages, { role: 'assistant', content: 'mock' }],
 *       usage: { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 },
 *       finishReason: 'stop',
 *       provider: null,
 *     };
 *   },
 *   async *stream(request) {
 *     yield { type: 'text-delta', text: 'mock' };
 *     yield { type: 'final', response: await this.generate(request) };
 *   },
 * };
 * ```
 */
export interface ModelAdapter {
  generate(request: AgentModelRequest): Promise<AgentModelResponse>;
  stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent>;
}

/** 标准化错误载荷，保证事件和结果中的错误可序列化。 */
export interface AgentError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: unknown;
}

/** 工具审批请求，供 approval 扩展或产品层 UI 使用。 */
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

/**
 * Agent 工具定义。
 *
 * Args:
 *   name: 暴露给模型的工具名。
 *   description: 暴露给模型的工具描述。
 *   input: Zod schema，用于输入校验和类型推导。
 *   execute: 工具执行函数。
 *   approval: 可选审批策略，返回 auto/required/denied。
 *
 * @example
 * ```ts
 * const readFile = defineTool({
 *   name: 'read_file',
 *   description: 'Read a file',
 *   input: z.object({ path: z.string() }),
 *   execute: async ({ path }, ctx) => ctx.environment.files?.readText(path) ?? '',
 * });
 * ```
 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<TInput>;
  execute(input: TInput, ctx: AgentToolContext): MaybePromise<TOutput>;
  approval?(input: TInput, ctx: AgentToolContext): MaybePromise<AgentApprovalDecision>;
  readonly inherit?: boolean;
}

export type AnyAgentTool = AgentTool<unknown, unknown>;

/** 工具执行上下文。 */
export interface AgentToolContext {
  readonly runId: string;
  readonly environment: AgentEnvironment;
  readonly metadata: Record<string, unknown>;
}

/** 扩展初始化上下文。 */
export interface AgentSetupContext {
  readonly agentId: string;
}

/** 单次运行扩展上下文。 */
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

/** 扩展与工具共享的运行上下文别名。 */
export type AgentContext = AgentRunContext;

export interface AgentRunState {
  readonly messages: AgentMessage[];
  readonly budget: ContextBudget;
  readonly turn: number;
  readonly queueDiagnostics: QueueDrainDiagnostic[];
}

export interface AgentTrace {
  readonly events: AgentStreamEvent[];
  readonly metadata: Record<string, unknown>;
}

export type AgentToolSet = ToolSet;
export type AgentToolChoice = ToolChoice<ToolSet>;

export type ContextBundle =
  | SystemContextBundle
  | MessageContextBundle
  | MemoryContextBundle
  | ToolContextBundle
  | MetadataContextBundle;

export interface BaseContextBundle {
  readonly id?: string;
  readonly source: string;
  readonly priority: number;
  readonly scope: 'run' | 'session' | 'user' | 'workspace';
  readonly retention: 'fixed' | 'compressible' | 'droppable';
  readonly persist: 'never' | 'session' | 'memory';
  readonly metadata?: Record<string, unknown>;
}

export interface SystemContextBundle extends BaseContextBundle {
  readonly kind: 'system';
  readonly text: string;
}

export interface MessageContextBundle extends BaseContextBundle {
  readonly kind: 'message';
  readonly message: AgentMessage;
}

export interface MemoryContextBundle extends BaseContextBundle {
  readonly kind: 'memory';
  readonly text: string;
  readonly memoryType: 'working' | 'episodic' | 'semantic';
}

export interface ToolContextBundle extends BaseContextBundle {
  readonly kind: 'tool-context';
  readonly activeTools?: string[];
  readonly toolInstructions?: string;
}

export interface MetadataContextBundle extends BaseContextBundle {
  readonly kind: 'metadata';
  readonly data: Record<string, unknown>;
}

export interface ContextSource<TContext = unknown> {
  readonly name: string;
  load(ctx: AgentRunContext<TContext>): MaybePromise<ContextBundle[]>;
}

export interface ContextReducer<TContext = unknown> {
  readonly name: string;
  reduce(
    input: ContextReductionInput<TContext>,
  ): MaybePromise<ContextReductionOutput>;
}

export interface ContextReductionInput<TContext = unknown> {
  readonly bundles: ContextBundle[];
  readonly ctx: AgentRunContext<TContext>;
  readonly budget: ContextBudget;
}

export interface ContextReductionOutput {
  readonly bundles: ContextBundle[];
  readonly report: ContextReductionReport;
}

export interface ContextBudget {
  readonly maxInputTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly lanes?: {
    readonly system?: number;
    readonly memory?: number;
    readonly history?: number;
    readonly retrieval?: number;
    readonly input?: number;
  };
}

export interface ContextReductionReport {
  readonly reducer: string;
  readonly beforeBundleCount: number;
  readonly afterBundleCount: number;
  readonly beforeTokenEstimate?: number;
  readonly afterTokenEstimate?: number;
  readonly summaryCount?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ModelCallPlanner<TContext = unknown> {
  plan(ctx: AgentRunContext<TContext>): MaybePromise<ModelCallPlan>;
}

export interface ModelCallPlan {
  readonly system?: string;
  readonly messages: AgentMessage[];
  readonly tools?: AgentToolSet;
  readonly activeTools?: string[];
  readonly toolChoice?: AgentToolChoice;
  readonly providerOptions?: Record<string, unknown>;
  readonly diagnostics: ContextDiagnostics;
}

export interface ContextDiagnostics {
  readonly bundles: Array<{
    readonly source: string;
    readonly kind: ContextBundle['kind'];
    readonly priority: number;
    readonly scope: ContextBundle['scope'];
    readonly retention: ContextBundle['retention'];
    readonly persist: ContextBundle['persist'];
    readonly tokenEstimate?: number;
  }>;
  readonly reducerReports: ContextReductionReport[];
  readonly summaryCount: number;
  readonly beforeMessageCount: number;
  readonly afterMessageCount: number;
  readonly beforeTokenEstimate?: number;
  readonly afterTokenEstimate?: number;
}

export interface SessionStore {
  load(sessionId: string): Promise<AgentMessage[]>;
  append(
    sessionId: string,
    messages: AgentMessage[],
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
  retrieve(ctx: AgentRunContext<TContext>): MaybePromise<ContextBundle[]>;
  observe?(
    event: MemoryObserveEvent,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  compact?(ctx: AgentRunContext<TContext>): MaybePromise<MemoryCompactResult>;
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
  onContextLoaded?(
    event: ContextLoadedEvent,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onContextReduced?(
    event: ContextReducedEvent,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onModelCallPlanned?(
    plan: ModelCallPlan,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
}

export interface ContextLoadedEvent {
  readonly bundles: ContextBundle[];
}

export interface ContextReducedEvent {
  readonly before: ContextBundle[];
  readonly after: ContextBundle[];
  readonly report: ContextReductionReport;
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
  readonly context?: ContextDiagnostics;
  readonly turns?: AgentTurnDiagnostics[];
  readonly queueDrains: QueueDrainDiagnostic[];
  readonly pendingCount: number;
  readonly resumeSource?: 'options.resume';
  readonly compactions?: SessionCompactionReport[];
  readonly subagents?: SubagentRunSummary[];
}

export interface AgentTurnDiagnostics {
  readonly turn: number;
  readonly context: ContextDiagnostics;
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

/**
 * 统一扩展 SPI。
 *
 * 扩展按 createAgent({ extensions }) 中的顺序执行。它们可以参与生命周期、
 * 转换消息、监听事件、保存结果和释放资源。
 *
 * @example
 * ```ts
 * const logEvents: AgentExtension = {
 *   name: 'logger',
 *   onEvent: (event) => console.log(event.type),
 * };
 * ```
 */
export interface AgentExtension {
  readonly name: string;
  readonly reducer?: ContextReducer;
  setup?(ctx: AgentSetupContext): MaybePromise<void>;
  beforeRun?(ctx: AgentRunContext): MaybePromise<void>;
  transformMessages?(
    messages: AgentMessage[],
    ctx: AgentRunContext,
  ): MaybePromise<AgentMessage[]>;
  onEvent?(event: AgentStreamEvent, ctx: AgentRunContext): MaybePromise<void>;
  afterRun?(result: AgentRunResult, ctx: AgentRunContext): MaybePromise<void>;
  teardown?(): MaybePromise<void>;
}

/**
 * Session 扩展可选实现的历史接口。
 *
 * Args:
 *   loadMessages: run 开始前读取历史消息。
 *   saveResult: run 结束后保存最终结果。
 */
export interface AgentSessionExtension extends AgentExtension {
  loadMessages?(): MaybePromise<AgentMessage[]>;
  saveResult?(result: AgentRunResult): MaybePromise<void>;
}

/** 文件系统抽象。 */
export interface AgentFileSystem {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
}

/** Shell 抽象。 */
export interface AgentShell {
  run(
    command: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<AgentShellResult>;
}

export interface AgentShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Agent 环境接口。
 *
 * 环境负责把文件、shell、远端执行器等外部能力注入给工具。测试可以传
 * memory environment，coding-agent 默认使用 createLocalEnvironment()。
 */
export interface AgentEnvironment {
  readonly files?: AgentFileSystem;
  readonly shell?: AgentShell;
  getInstructions?(): MaybePromise<string>;
  close?(): MaybePromise<void>;
}

/**
 * createAgent 主配置。
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   model: 'openai:gpt-4.1-mini',
 *   instructions: 'You are a code reviewer.',
 *   environment: createLocalEnvironment({ cwd: process.cwd() }),
 *   tools: createFilesystemTools(),
 *   extensions: [createMemorySession()],
 * });
 * ```
 */
export interface CreateAgentOptions {
  readonly model: AgentModel;
  readonly name?: string;
  readonly instructions?: string;
  readonly modelSettings?: Record<string, unknown>;
  readonly modelAdapter?: ModelAdapter;
  readonly environment?: AgentEnvironment;
  readonly tools?: readonly AnyAgentTool[];
  readonly extensions?: readonly AgentExtension[];
  readonly context?: readonly ContextSource[];
  readonly reducers?: readonly ContextReducer[];
  readonly session?: SessionStore;
  readonly memory?: AgentMemory;
  readonly observers?: readonly AgentObserver[];
  readonly planner?: ModelCallPlanner;
  readonly compactor?: SessionCompactor;
  readonly metadata?: Record<string, unknown>;
}
