/**
 * 通用 Agent engine 的公开契约集中定义运行输入、Environment Handle、stream 与 deferred resume。
 *
 * engine 只依赖本文件中的小型能力接口，不知道 Thread、JSON-RPC、产品配置或持久化实现。
 * 每次 run 拥有独立 context、取消信号和 stream；Environment Handle 由调用方 attach 并由 Agent 关闭。
 */
import type { EnvironmentHandle } from '../../environment/index.js';

import type {
  AgentEventRecorder,
  AgentObserver,
  EngineEvent,
  MessageCompactor,
  ModelCompactor,
} from './events.js';
import type {
  AgentMessage,
  AgentModel,
  ModelCallConfiguration,
  AgentModelSettings,
  MessageTransform,
  ModelAdapter,
  ModelInputDiagnostics,
  PrepareModelInput,
  ProviderOptionsResolver,
  SystemSection,
} from './model.js';
import type { AgentToolCall, AnyAgentTool } from './tools.js';

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
  readonly modelSettings?: AgentModelSettings;
  /** 正整数限制模型轮次；`-1` 表示不设置上限。 */
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Record<string, unknown>;
  readonly context?: unknown;
  /** 仅参与当前 run 的 system 输入，不写入 transcript 或后续 session history。 */
  readonly ephemeralInstructions?: string;
  readonly resume?: DeferredRunResults;
}

export interface Agent {
  /**
   * 启动一次 run，并等待其事件流和资源收尾全部完成。
   *
   * Args:
   * - `input`: 字符串、消息序列或结构化 prompt；会在 run 创建时归一化为独立消息。
   * - `options`: 仅作用于当前 run 的 ID、model settings、turn 上限、取消信号、metadata、context、临时指令和 resume 数据。
   *
   * Returns:
   * - Promise 在 run 终态产生且环境关闭后兑现为最终 `AgentRunResult`。
   *
   * Throws:
   * - 输入非法、run 已关闭、model/tool 失败或取消时直接拒绝或返回对应终态。
   */
  run(input: AgentInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  /**
   * 启动一次独立 run，并立即返回带背压的事件 stream。
   *
   * Args:
   * - `input`: 字符串、消息序列或结构化 prompt；在 stream 创建时复制并归一化。
   * - `options`: 仅作用于当前 run 的稳定选项；调用方继续拥有传入对象。
   *
   * Returns:
   * - 返回 `AgentStream`；事件按生产顺序迭代，`final` 在资源收尾完成后兑现。
   */
  stream(input: AgentInput, options?: AgentRunOptions): AgentStream;
  /**
   * 从明确的 deferred items 与结果创建一条恢复 run。
   *
   * Args:
   * - `input`: 已持久化消息和与其精确匹配的 deferred 结果；不会从产品 store 隐式加载历史。
   * - `options`: 当前恢复 run 的稳定选项；不得再携带另一份 `resume` 数据。
   *
   * Returns:
   * - 返回新的 `AgentStream`；恢复校验失败时不会创建部分 run。
   */
  resume(input: AgentResumeInput, options?: AgentRunOptions): AgentStream;
  /**
   * 使用当前主 Agent 的完整模型配置执行上下文压缩。
   *
   * Args:
   * - `input`: 用于恢复稳定模型前缀的完整历史、待压缩历史、compact 提示词和取消信号。
   *
   * Returns:
   * - 返回主模型生成的 compact 文本与该次调用的 usage。
   */
  compact(input: {
    readonly contextMessages: ReadonlyArray<AgentMessage>;
    readonly messages: ReadonlyArray<AgentMessage>;
    readonly prompt: string;
    readonly signal: AbortSignal;
  }): ReturnType<ModelCompactor['compact']>;
  /**
   * 读取该 Agent 最近一次主模型请求派生的压缩能力。
   *
   * Args:
   * - 无：读取 Agent 内部保留的主模型请求状态。
   *
   * Returns:
   * - 已形成主模型上下文时返回压缩器，否则返回 `undefined`。
   */
  modelCompactor(): ModelCompactor | undefined;
  /**
   * 关闭 Agent 稳定配置与仍由门面持有的共享资源。
   *
   * Args:
   * - 无：单次 run 资源由各自 stream 终态负责关闭。
   *
   * Returns:
   * - Promise 在门面拥有的资源释放后兑现；完成后不能再启动 run。
   *
   * Throws:
   * - 资源关闭失败时拒绝，并保留底层错误。
   */
  close(): Promise<void>;
}

export interface AgentResumeInput {
  readonly messages: ReadonlyArray<AgentMessage>;
  readonly deferred: DeferredRunResults;
}

export interface AgentStream extends AsyncIterable<EngineEvent> {
  /** 事件生产结束并完成 run 资源关闭后兑现的唯一终态。 */
  readonly final: Promise<AgentRunResult>;
  /**
   * 把一条 steering message 加入当前 run 的下一 turn 队列。
   *
   * Args:
   * - `message`: 已满足 engine message schema 的完整消息；按调用顺序排队且只消费一次。
   *
   * Returns:
   * - 消息完成入队后同步返回；stream 已结束时直接抛错。
   */
  steer(message: AgentMessage): void;
  /**
   * 中止当前 stream 对应的 run。
   *
   * Args:
   * - `reason`: 传给取消信号和最终错误归一化的原始原因；允许显式省略。
   *
   * Returns:
   * - 取消信号发出后同步返回；终态仍通过 `final` 观察。
   */
  abort(reason?: unknown): void;
}

export interface AgentUsage {
  readonly requests: number;
  readonly inputTokens: number;
  /** 最近一次模型请求实际占用的输入 token；不参与累计计费。 */
  readonly lastInputTokens?: number | undefined;
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
  | 'tool-result-required'
  | 'interrupted'
  | 'no-progress'
  | 'content-filter'
  | 'error'
  | 'unknown';

export interface AgentRunResult {
  readonly id: string;
  readonly text: string;
  readonly output: string;
  readonly messages: AgentMessage[];
  readonly newMessages: AgentMessage[];
  readonly usage: AgentUsage;
  readonly finishReason: AgentFinishReason;
  readonly toolCalls: AgentToolCall[];
  readonly pending: DeferredRunItem[];
  readonly diagnostics: AgentRunDiagnostics;
  readonly compactions: ReadonlyArray<MessageCompactionReport>;
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
  readonly environment: EnvironmentHandle;
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

export interface MessageCompactionReport {
  readonly compactor: string;
  readonly beforeMessageCount: number;
  readonly afterMessageCount: number;
  readonly summary: string;
  readonly keptMessageCount: number;
  readonly tokensBefore: number;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentRunDiagnostics {
  readonly modelInput?: ModelInputDiagnostics;
  readonly turns: AgentTurnDiagnostics[];
  readonly queueDrains: QueueDrainDiagnostic[];
  readonly pendingCount: number;
  readonly resumeSource?: 'options.resume';
  readonly compactions: MessageCompactionReport[];
}

export interface AgentTurnDiagnostics {
  readonly turn: number;
  readonly modelInput?: ModelInputDiagnostics;
  readonly queueDrains: QueueDrainDiagnostic[];
  readonly finishReason: AgentFinishReason;
  readonly newMessageCount: number;
}

export interface CreateAgentOptions<TContext = unknown> {
  readonly model: AgentModel;
  /** 每次调用必须携带装配时固定的 Agent 与模型解析身份。 */
  readonly modelCall: ModelCallConfiguration;
  readonly name?: string;
  readonly instructions?: string;
  readonly modelSettings?: AgentModelSettings;
  readonly modelAdapter: ModelAdapter;
  /** 当前 Agent 独占的运行环境；无外部能力时调用方也必须显式传入空环境。 */
  readonly environment: EnvironmentHandle;
  /** 完整执行注册表；超过直连上限时同时包含目标工具和路由工具。 */
  readonly executionTools: readonly AnyAgentTool[];
  /** 模型可见工具集；由产品层决定直接暴露或切换为 tool_search/call_tool。 */
  readonly modelTools: readonly AnyAgentTool[];
  readonly observers?: readonly AgentObserver<TContext>[];
  readonly eventRecorder?: AgentEventRecorder<TContext>;
  readonly stream?: { readonly maxBufferedEvents: number };
  readonly compactor?: MessageCompactor;
  readonly modelCompactor?: ModelCompactor;
  readonly metadata?: Record<string, unknown>;
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
