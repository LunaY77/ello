import type {
  ModelMessage as AiModelMessage,
  LanguageModel,
  ToolChoice,
  ToolSet,
} from 'ai';
import type { z } from 'zod';

import type { AgentStreamEvent } from './events.js';

/**
 * `@ello/agent` 运行时的公共类型契约。
 *
 * 这是与 provider 无关的 Agent 循环内核对外暴露的全部类型定义：Agent 接口、
 * 运行选项与结果、消息/工具/会话/环境模型，以及挂接点（observer、压缩器、
 * 系统段、消息变换等）。内核内部实现一律以这些类型为边界，产品层（如
 * coding-agent）只通过这里的类型与内核交互，从而保持解耦。
 *
 * 设计取向：消息与工具类型直接复用 `ai` 包（Vercel AI SDK）的形态，避免再造
 * 一套等价模型；其余类型则刻意保持 provider 无关，不泄漏任何具体厂商细节。
 */

/** 同步或异步值：允许实现方按需返回 `T` 或 `Promise<T>`。 */
export type MaybePromise<T> = T | Promise<T>;

/** 一条对话消息，直接复用 `ai` 包的消息形态（含 role、content part 等）。 */
export type AgentMessage = AiModelMessage;
/** 用户消息：`AgentMessage` 中 `role: 'user'` 的子集。 */
export type UserMessage = Extract<AiModelMessage, { role: 'user' }>;
/** 助手消息：`AgentMessage` 中 `role: 'assistant'` 的子集。 */
export type AssistantMessage = Extract<AiModelMessage, { role: 'assistant' }>;

/**
 * 一次运行的输入，支持三种写法：
 * - 纯字符串：作为单条用户提示；
 * - 消息数组：直接作为对话历史；
 * - 结构化对象：可同时携带 `prompt`、`messages` 与自定义 `context`。
 */
export type AgentInput =
  | string
  | AgentMessage[]
  | {
      /** 单条用户提示文本。 */
      prompt?: string;
      /** 预置的对话消息。 */
      messages?: AgentMessage[];
      /** 透传给系统段/工具的运行上下文。 */
      context?: Record<string, unknown>;
    };

/** 模型标识：可以是 `"provider:model"` 形式的字符串，或 `ai` 包的 `LanguageModel`。 */
export type AgentModel = string | LanguageModel;

/** 单次 `run`/`stream`/`resume` 的运行选项。 */
export interface AgentRunOptions {
  /** 透传给底层模型的 provider 设置（如温度、top-p 等）。 */
  readonly modelSettings?: Record<string, unknown>;
  /** 单次运行允许的最大回合数，防止无限循环。 */
  readonly maxTurns?: number;
  /** 取消信号，触发后中断当前运行。 */
  readonly signal?: AbortSignal;
  /** 附加到本次运行的任意元数据，会透传到上下文与诊断。 */
  readonly metadata?: Record<string, unknown>;
  /** 预置消息历史；与会话存储中的历史合并。 */
  readonly messages?: AgentMessage[];
  /** 会话 ID，决定从哪个持久化会话加载/追加历史。 */
  readonly sessionId?: string;
  /** 透传给系统段/工具的自定义运行上下文。 */
  readonly context?: unknown;
  /** 从挂起点恢复运行所需的延迟结果（审批/工具结果）。 */
  readonly resume?: DeferredRunResults;
}

/**
 * Agent 对外的核心接口，仅暴露四个方法。
 *
 * `run` 一次跑到结束并返回结果；`stream` 返回可迭代的事件流；`resume` 从审批
 * 等挂起点继续；`close` 释放底层资源（环境、会话存储等）。
 */
export interface Agent {
  /** 跑完整次运行并返回最终结果。 */
  run(input: AgentInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  /** 以事件流形式运行，边产出 `AgentStreamEvent` 边推进。 */
  stream(input: AgentInput, options?: AgentRunOptions): AgentStream;
  /** 用延迟结果（审批决定、工具结果）从挂起点恢复运行。 */
  resume(deferred: DeferredRunResults, options?: AgentRunOptions): AgentStream;
  /** 关闭 Agent，释放环境与会话等资源。 */
  close(): Promise<void>;
}

/**
 * 运行事件流：既是 `AgentStreamEvent` 的异步可迭代对象，又提供：
 * - `final`：解析为本次运行最终结果的 Promise；
 * - `abort`：主动中断本次运行。
 */
export interface AgentStream extends AsyncIterable<AgentStreamEvent> {
  /** 解析为最终运行结果；可在迭代结束后 await。 */
  readonly final: Promise<AgentRunResult>;
  /** 向正在运行的下一回合追加用户引导消息。 */
  steer(message: AgentMessage): void;
  /** 中断本次运行，可附带原因。 */
  abort(reason?: unknown): void;
}

/** 一次运行的资源用量统计（按整次运行累计）。 */
export interface AgentUsage {
  /** 向模型发起的请求次数。 */
  readonly requests: number;
  /** 累计输入 token。 */
  readonly inputTokens: number;
  /** 累计输出 token。 */
  readonly outputTokens: number;
  /** 命中缓存读取的 token。 */
  readonly cacheReadTokens: number;
  /** 写入缓存的 token。 */
  readonly cacheWriteTokens: number;
  /** 累计工具调用次数。 */
  readonly toolCalls: number;
}

/**
 * 运行结束原因：
 * - `stop` 模型正常收尾；`length` 触达长度上限；`tool-calls` 停在待执行工具调用；
 * - `approval-required` 等待审批；`interrupted` 被中断；`no-progress` 多回合无进展熔断；
 * - `content-filter` 内容过滤；`error` 出错；`unknown` 未知。
 */
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

/** 一次工具调用的归一化记录（调度、完成或失败后均以此形态呈现）。 */
export interface AgentToolCall {
  /** 工具调用 ID，用于关联审批/结果。 */
  readonly id: string;
  /** 被调用的工具名。 */
  readonly name: string;
  /** 工具入参。 */
  readonly input: unknown;
  /** 工具输出（成功时存在）。 */
  readonly output?: unknown;
  /** 工具执行错误（失败时存在）。 */
  readonly error?: AgentError;
}

/** 一次运行结束后的完整结果。 */
export interface AgentRunResult {
  /** 本次运行的唯一 ID。 */
  readonly id: string;
  /** 模型产出的原始文本（可能为空）。 */
  readonly text?: string;
  /** 规范化后的最终输出文本（消费方主要读这个）。 */
  readonly output: string;
  /** 本次运行后的完整消息历史。 */
  readonly messages: AgentMessage[];
  /** 资源用量统计。 */
  readonly usage: AgentUsage;
  /** 运行结束原因。 */
  readonly finishReason: AgentFinishReason;
  /** 本次运行涉及的工具调用。 */
  readonly toolCalls: AgentToolCall[];
  /** 待处理的延迟项（如等待审批），存在则可用于 `resume`。 */
  readonly pending?: DeferredRunItem[];
  /** 运行诊断信息（按需开启）。 */
  readonly diagnostics?: AgentRunDiagnostics;
  /** 运行元数据。 */
  readonly metadata: Record<string, unknown>;
}

/**
 * 一次模型调用的已组装输入（system + 消息 + 工具等）。
 * 由内核装配，并可经 {@link PrepareModelInput} 等钩子最后改写。
 */
export interface ModelInput {
  /** 拼接后的系统提示词。 */
  readonly system?: string;
  /** 发送给模型的消息序列。 */
  readonly messages: AgentMessage[];
  /** 可用工具集。 */
  readonly tools: AgentToolSet;
  /** 本回合实际启用的工具名（用于裁剪工具集）。 */
  readonly activeTools?: readonly string[];
  /** 工具选择策略（auto/required/指定工具等）。 */
  readonly toolChoice?: AgentToolChoice;
  /** 透传给 provider 的额外选项。 */
  readonly providerOptions?: Record<string, unknown>;
  /** 本次输入的诊断信息。 */
  readonly diagnostics?: ModelInputDiagnostics;
}

/** 模型输入装配过程的诊断信息，便于排查上下文构造。 */
export interface ModelInputDiagnostics {
  /** 参与拼接的系统段数量。 */
  readonly systemSections: number;
  /** 实际发送的消息条数。 */
  readonly messageCount: number;
  /** 估算的输入 token 数。 */
  readonly estimatedInputTokens?: number;
  /** 本回合启用的工具名。 */
  readonly activeTools?: readonly string[];
  /** 是否设置了 provider 选项。 */
  readonly hasProviderOptions: boolean;
  /** 实际应用的消息变换名列表。 */
  readonly appliedMessageTransforms: readonly string[];
}

/**
 * 系统段：每回合按需生成一段系统提示文本（返回 null/undefined 表示本回合不贡献）。
 * 用于把动态上下文（记忆、技能、会话摘要等）注入系统提示。
 */
export type SystemSection<TContext = unknown> = (
  run: AgentRunContext<TContext>,
) => MaybePromise<string | null | undefined>;

/**
 * 消息变换：在发送给模型前对消息序列做改写（如裁剪、压缩、配对修复）。
 * 多个变换按注册顺序串联应用。
 */
export type MessageTransform<TContext = unknown> = (
  messages: readonly AgentMessage[],
  run: AgentRunContext<TContext>,
) => MaybePromise<readonly AgentMessage[]>;

/** provider 选项解析器：按运行上下文动态决定透传给 provider 的选项。 */
export type ProviderOptionsResolver<TContext = unknown> = (
  run: AgentRunContext<TContext>,
) => MaybePromise<Record<string, unknown> | null | undefined>;

/** 最终钩子：在模型输入装配完成后整体改写 {@link ModelInput}。 */
export type PrepareModelInput<TContext = unknown> = (
  input: ModelInput,
  run: AgentRunContext<TContext>,
) => MaybePromise<ModelInput>;

/** 向 {@link ModelAdapter} 发起一次调用的请求形态（provider 无关）。 */
export interface AgentModelRequest {
  /** 所属运行 ID。 */
  readonly runId: string;
  /** 目标模型。 */
  readonly model: AgentModel;
  /** 系统提示词。 */
  readonly system?: string;
  /** 消息序列。 */
  readonly messages: AgentMessage[];
  /** `ai` 包形态的工具集。 */
  readonly tools: ToolSet;
  /** 本回合启用的工具名。 */
  readonly activeTools?: readonly string[];
  /** 工具选择策略。 */
  readonly toolChoice?: AgentToolChoice;
  /** provider 额外选项。 */
  readonly providerOptions?: Record<string, unknown>;
  /** provider 模型设置（温度等）。 */
  readonly modelSettings: Record<string, unknown>;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** {@link ModelAdapter} 一次调用的归一化响应。 */
export interface AgentModelResponse {
  /** 模型产出文本。 */
  readonly text: string;
  /** 调用后的完整消息历史。 */
  readonly messages: AgentMessage[];
  /** 本次调用新增的消息（增量）。 */
  readonly newMessages?: AgentMessage[];
  /** 本次模型请求的工具调用。 */
  readonly toolCalls?: AgentToolCall[];
  /** 工具结果（如已执行）。 */
  readonly toolResults?: unknown[];
  /** 本次调用用量。 */
  readonly usage: AgentUsage;
  /** 结束原因。 */
  readonly finishReason: AgentFinishReason;
  /** provider 原始响应对象（逃生通道）。 */
  readonly provider: unknown;
}

/** 流式模型事件：文本增量，或最终聚合响应。 */
export type AgentModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'final'; response: AgentModelResponse };

/**
 * 模型适配器：把 provider 无关的请求翻译为具体厂商调用。
 * 内核通过它与模型对话，从而不耦合任何具体 provider。
 */
export interface ModelAdapter {
  /** 一次性补全。 */
  generate(request: AgentModelRequest): Promise<AgentModelResponse>;
  /** 流式补全，逐步产出 {@link AgentModelEvent}。 */
  stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent>;
}

/** 可序列化的归一化错误形态（见 `normalizeAgentError`）。 */
export interface AgentError {
  /** 错误名。 */
  readonly name: string;
  /** 错误信息。 */
  readonly message: string;
  /** 调用栈（如有）。 */
  readonly stack?: string;
  /** 原始底层错误（如有）。 */
  readonly cause?: unknown;
}

/** 一次工具审批请求，提交给前端供用户决策。 */
export interface AgentApprovalRequest {
  /** 审批请求 ID。 */
  readonly id: string;
  /** 关联的工具调用 ID。 */
  readonly toolCallId: string;
  /** 待审批的工具名。 */
  readonly name: string;
  /** 待审批的工具入参。 */
  readonly input: unknown;
  /** 需要审批的原因。 */
  readonly reason?: string;
}

/** 审批判定：`auto` 自动放行、`required` 需人工审批、`denied` 直接拒绝。 */
export type AgentApprovalDecision = 'auto' | 'required' | 'denied';
/** 审批策略：根据工具入参与上下文给出 {@link AgentApprovalDecision}。 */
export type AgentApprovalPolicy<TInput = unknown> = (
  input: TInput,
  ctx: AgentToolContext,
) => MaybePromise<AgentApprovalDecision>;

/**
 * Agent 工具定义：名称、描述、Zod 输入 schema 与执行函数，可选审批策略。
 * 这是模型可调用能力的最小单元。
 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  /** 工具名（模型调用时使用）。 */
  readonly name: string;
  /** 工具描述（供模型选择工具）。 */
  readonly description: string;
  /** 输入 Zod schema，用于校验并推导类型。 */
  readonly input: z.ZodType<TInput>;
  /** 执行函数。 */
  execute(input: TInput, ctx: AgentToolContext): MaybePromise<TOutput>;
  /** 可选审批策略：执行前据此决定放行/审批/拒绝。 */
  approval?(
    input: TInput,
    ctx: AgentToolContext,
  ): MaybePromise<AgentApprovalDecision>;
  /** 是否被子代理继承。 */
  readonly inherit?: boolean;
}

/** 擦除了类型参数的工具类型，便于以同构数组传递工具集合。 */
export type AnyAgentTool = AgentTool<unknown, unknown>;

/** 工具执行时可访问的上下文。 */
export interface AgentToolContext {
  /** 所属运行 ID。 */
  readonly runId: string;
  /** 运行环境（文件系统、shell、资源等）。 */
  readonly environment: AgentEnvironment;
  /** 运行元数据。 */
  readonly metadata: Record<string, unknown>;
}

/** Agent 一次性装配阶段的上下文。 */
export interface AgentSetupContext {
  /** Agent 标识。 */
  readonly agentId: string;
}

/**
 * 运行上下文：贯穿单次运行的只读快照，供系统段、工具、observer、压缩器读取。
 * 泛型 `TContext` 为调用方自定义上下文类型。
 */
export interface AgentRunContext<TContext = unknown> {
  /** 运行 ID。 */
  readonly runId: string;
  /** Agent 名称。 */
  readonly agentName: string;
  /** 会话 ID（如有）。 */
  readonly sessionId?: string;
  /** 本次运行的原始输入。 */
  readonly input: AgentInput;
  /** 调用方自定义上下文。 */
  readonly context: TContext;
  /** 本次运行选项。 */
  readonly options: AgentRunOptions;
  /** 运行环境。 */
  readonly environment: AgentEnvironment;
  /** 运行元数据。 */
  readonly metadata: Record<string, unknown>;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
  /** 可变的运行状态（消息、回合数等）。 */
  readonly state: AgentRunState;
  /** 运行轨迹（已发出的事件与元数据）。 */
  readonly trace: AgentTrace;
}

/** {@link AgentRunContext} 的非泛型别名。 */
export type AgentContext = AgentRunContext;

/** 运行中的可变状态。 */
export interface AgentRunState {
  /** 当前消息历史。 */
  readonly messages: AgentMessage[];
  /** 预算账本（token/回合等）。 */
  readonly budget: Record<string, unknown>;
  /** 当前回合序号。 */
  readonly turn: number;
  /** 队列抽空诊断。 */
  readonly queueDiagnostics: QueueDrainDiagnostic[];
}

/** 运行轨迹：累积已发出的事件，便于回放与调试。 */
export interface AgentTrace {
  /** 已发出的事件序列。 */
  readonly events: AgentStreamEvent[];
  /** 轨迹元数据。 */
  readonly metadata: Record<string, unknown>;
}

/** 工具集类型，复用 `ai` 包的 `ToolSet`。 */
export type AgentToolSet = ToolSet;
/** 工具选择策略类型，复用 `ai` 包的 `ToolChoice`。 */
export type AgentToolChoice = ToolChoice<ToolSet>;

/**
 * 会话存储：负责按 `sessionId` 持久化与读取消息历史。
 * `load`/`append` 为必需；`appendEvent`/`compact`/`replace` 为可选增强能力。
 */
export interface SessionStore {
  /** 加载某会话的线性消息历史。 */
  load(sessionId: string): Promise<AgentMessage[]>;
  /** 向会话追加消息。 */
  append(
    sessionId: string,
    messages: AgentMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  /** 可选：持久化单个流事件（用于事件溯源/重放）。 */
  appendEvent?(sessionId: string, event: AgentStreamEvent): Promise<void>;
  /** 可选：记录一次压缩报告。 */
  compact?(
    sessionId: string,
    result: SessionCompactionReport,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  /** 可选：整体改写会话历史（压缩器据此落盘摘要后的历史）。 */
  replace?(
    sessionId: string,
    messages: AgentMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * 运行观察者：在运行生命周期各阶段被回调，用于日志、指标、记忆维护等副作用。
 * 所有回调均为可选，按需实现。
 */
export interface AgentObserver<TContext = unknown> {
  /** 运行开始。 */
  onRunStarted?(
    event: { readonly runId: string },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /** 单个回合开始。 */
  onTurnStarted?(
    event: { readonly runId: string; readonly turnIndex: number },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /** 工具被调度（即将执行）。 */
  onToolScheduled?(
    event: AgentToolCall,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /** 工具需要审批。 */
  onToolApprovalRequired?(
    event: DeferredApprovalItem,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /** 工具执行完成。 */
  onToolCompleted?(
    event: AgentToolCall,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /** 运行成功完成。 */
  onRunCompleted?(
    result: AgentRunResult,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /** 运行失败。 */
  onRunFailed?(
    event: { readonly error: AgentError },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
}

/**
 * 会话压缩器：在回合之间由内核调用 `maybeCompact`，决定是否压缩历史。
 * 返回压缩报告表示已压缩，返回 null 表示本次不压缩。
 */
export interface SessionCompactor<TContext = unknown> {
  /** 压缩器名称（写入报告，便于追溯）。 */
  readonly name: string;
  /** 判断并执行一次压缩；不需要压缩时返回 null。 */
  maybeCompact(
    sessionId: string,
    store: SessionStore,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<SessionCompactionReport | null>;
}

/** 一次压缩的结果报告。 */
export interface SessionCompactionReport {
  /** 执行压缩的压缩器名。 */
  readonly compactor: string;
  /** 压缩前消息条数。 */
  readonly beforeMessageCount: number;
  /** 压缩后消息条数。 */
  readonly afterMessageCount: number;
  /** 附加元数据（如切点、压缩前 token 等）。 */
  readonly metadata?: Record<string, unknown>;
}

/** 消息队列消费模式：一次全部抽空，或每次仅取一条。 */
export type AgentMessageQueueMode = 'all' | 'one-at-a-time';

/** 运行期消息队列：缓冲运行中追加的输入（如 steer），按模式抽空。 */
export interface AgentMessageQueue<T = AgentMessage> {
  /** 抽空模式。 */
  readonly mode: AgentMessageQueueMode;
  /** 队列长度。 */
  readonly size: number;
  /** 是否有待处理项。 */
  readonly hasItems: boolean;
  /** 入队。 */
  push(item: T): void;
  /** 按模式抽空并返回取出的项。 */
  drain(): T[];
  /** 清空队列。 */
  clear(): void;
}

/** 运行控制状态机的状态。 */
export type AgentRunControlStatus =
  | 'running'
  | 'waiting_approval'
  | 'interrupted'
  | 'completed'
  | 'failed';

/** 延迟运行项：运行挂起时记录的待处理项，供 `resume` 继续。 */
export type DeferredRunItem =
  | DeferredApprovalItem
  | DeferredToolCallItem
  | InterruptedRunItem;

/** 待审批项：因工具需要审批而挂起。 */
export interface DeferredApprovalItem {
  /** 判别标签。 */
  readonly kind: 'approval';
  /** 工具调用 ID。 */
  readonly toolCallId: string;
  /** 工具名。 */
  readonly toolName: string;
  /** 工具入参。 */
  readonly input?: unknown;
  /** 需审批原因。 */
  readonly reason?: string;
}

/** 待执行工具调用项：工具调用被延迟到 `resume` 时执行。 */
export interface DeferredToolCallItem {
  /** 判别标签。 */
  readonly kind: 'tool-call';
  /** 工具调用 ID。 */
  readonly toolCallId: string;
  /** 工具名。 */
  readonly toolName: string;
  /** 工具入参。 */
  readonly input?: unknown;
}

/** 被中断项：运行被中断时保存的现场消息。 */
export interface InterruptedRunItem {
  /** 判别标签。 */
  readonly kind: 'interrupted';
  /** 中断时的消息现场。 */
  readonly messages: AgentMessage[];
  /** 中断原因。 */
  readonly reason?: string;
}

/** 恢复运行所需的延迟结果：待处理项 + 审批决定 + 工具结果。 */
export interface DeferredRunResults {
  /** 此前挂起的延迟项。 */
  readonly deferred?: readonly DeferredRunItem[];
  /** 按工具调用 ID 给出的审批决定（布尔或带原因的对象）。 */
  readonly approvals?: Record<
    string,
    boolean | { readonly approved: boolean; readonly reason?: string }
  >;
  /** 按工具调用 ID 注入的工具结果（外部执行场景）。 */
  readonly toolResults?: Record<string, unknown>;
}

/** 队列抽空诊断：记录某队列本回合抽空了多少项。 */
export interface QueueDrainDiagnostic {
  /** 队列名。 */
  readonly queue: string;
  /** 抽空数量。 */
  readonly count: number;
}

/** 整次运行的诊断聚合。 */
export interface AgentRunDiagnostics {
  /** 首次模型输入诊断。 */
  readonly modelInput?: ModelInputDiagnostics;
  /** 各回合诊断。 */
  readonly turns?: AgentTurnDiagnostics[];
  /** 队列抽空记录。 */
  readonly queueDrains: QueueDrainDiagnostic[];
  /** 待处理延迟项数量。 */
  readonly pendingCount: number;
  /** 恢复来源（如来自 `options.resume`）。 */
  readonly resumeSource?: 'options.resume';
  /** 本次运行发生的压缩报告。 */
  readonly compactions?: SessionCompactionReport[];
  /** 本次运行涉及的子代理摘要。 */
  readonly subagents?: SubagentRunSummary[];
}

/** 单个回合的诊断。 */
export interface AgentTurnDiagnostics {
  /** 回合序号。 */
  readonly turn: number;
  /** 本回合模型输入诊断。 */
  readonly modelInput: ModelInputDiagnostics;
  /** 本回合队列抽空记录。 */
  readonly queueDrains: QueueDrainDiagnostic[];
  /** 本回合结束原因。 */
  readonly finishReason: AgentFinishReason;
  /** 本回合新增消息数。 */
  readonly newMessageCount: number;
}

/** 技能定义：一组可按需激活的指令 + 专属工具。 */
export interface AgentSkill {
  /** 技能名。 */
  readonly name: string;
  /** 技能描述。 */
  readonly description: string;
  /** 激活后注入的指令文本。 */
  readonly instructions: string;
  /** 技能附带的专属工具。 */
  readonly tools?: readonly AnyAgentTool[];
  /** 技能元数据。 */
  readonly metadata?: Record<string, unknown>;
}

/** 子代理定义：可被主代理委派任务的独立 Agent 配置。 */
export interface SubagentDefinition {
  /** 子代理名。 */
  readonly name: string;
  /** 子代理描述（供主代理选择委派对象）。 */
  readonly description: string;
  /** 子代理系统指令。 */
  readonly instructions: string;
  /** 是否继承父代理工具。 */
  readonly inheritTools?: boolean;
  /** 子代理专属工具。 */
  readonly tools?: readonly AnyAgentTool[];
  /** 子代理元数据。 */
  readonly metadata?: Record<string, unknown>;
}

/** 一次子代理运行的摘要，回填到父运行诊断。 */
export interface SubagentRunSummary {
  /** 子代理名。 */
  readonly name: string;
  /** 子代理运行 ID。 */
  readonly runId: string;
  /** 子代理用量。 */
  readonly usage: AgentUsage;
  /** 子代理结束原因。 */
  readonly finishReason: AgentFinishReason;
}

/** 文件系统能力抽象：供环境与工具读写文件。 */
export interface AgentFileSystem {
  /** 读取文本文件。 */
  readText(path: string): Promise<string>;
  /** 写入文本文件。 */
  writeText(path: string, content: string): Promise<void>;
  /** 列出目录条目。 */
  listDir(path: string): Promise<string[]>;
  /** 可选：贡献给系统提示的上下文说明。 */
  getContextInstructions?(): MaybePromise<string | null>;
  /** 可选：释放资源。 */
  close?(): MaybePromise<void>;
}

/** Shell 命令执行能力抽象。 */
export interface AgentShell {
  /** 执行一条命令，可指定工作目录、超时与环境变量。 */
  run(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    },
  ): Promise<AgentShellResult>;
  /** 可选：贡献给系统提示的上下文说明。 */
  getContextInstructions?(): MaybePromise<string | null>;
  /** 可选：释放资源。 */
  close?(): MaybePromise<void>;
}

/** Shell 命令执行结果。 */
export interface AgentShellResult {
  /** 退出码。 */
  readonly exitCode: number;
  /** 标准输出。 */
  readonly stdout: string;
  /** 标准错误。 */
  readonly stderr: string;
}

/**
 * 运行环境：聚合文件系统、shell、资源注册表等外部能力，并提供生命周期钩子。
 * 工具通过 {@link AgentToolContext} 访问环境；内核在运行前后调用其钩子。
 */
export interface AgentEnvironment {
  /** 文件系统能力。 */
  readonly fileSystem?: AgentFileSystem;
  /** 文件系统能力别名。 */
  readonly files?: AgentFileSystem;
  /** Shell 能力。 */
  readonly shell?: AgentShell;
  /** 资源注册表。 */
  readonly resources?: AgentResourceRegistry;
  /** 运行前的一次性装配。 */
  setup?(ctx: AgentRunContext): MaybePromise<void>;
  /** 按运行上下文贡献系统提示说明。 */
  getContextInstructions?(ctx: AgentRunContext): MaybePromise<string | null>;
  /** 贡献静态系统提示说明。 */
  getInstructions?(): MaybePromise<string | null>;
  /** 监听流事件（如据事件做副作用）。 */
  onEvent?(event: AgentStreamEvent, ctx: AgentRunContext): MaybePromise<void>;
  /** 释放环境资源。 */
  close?(): MaybePromise<void>;
}

/** 可由资源注册表管理的资源：带可选的装配/释放/上下文说明钩子。 */
export interface AgentResource {
  /** 装配。 */
  setup?(): MaybePromise<void>;
  /** 释放。 */
  close?(): MaybePromise<void>;
  /** 贡献系统提示说明。 */
  getContextInstructions?(): MaybePromise<string | null>;
}

/** 资源工厂：按环境惰性创建资源。 */
export type AgentResourceFactory = (
  environment: AgentEnvironment,
) => MaybePromise<AgentResource>;

/** 资源注册表：按 key 注册/惰性创建/检索环境资源。 */
export interface AgentResourceRegistry {
  /** 绑定所属环境。 */
  bind?(environment: AgentEnvironment): void;
  /** 装配所有已注册资源。 */
  setupAll?(): MaybePromise<void>;
  /** 注册一个已就绪的资源。 */
  register(key: string, resource: AgentResource): void;
  /** 注册一个惰性资源工厂。 */
  registerFactory(key: string, factory: AgentResourceFactory): void;
  /** 取已有资源。 */
  get(key: string): AgentResource | undefined;
  /** 取或惰性创建资源。 */
  getOrCreate(key: string): Promise<AgentResource>;
  /** 列出所有 key。 */
  keys(): string[];
  /** 汇总所有资源的上下文说明。 */
  getContextInstructions?(): MaybePromise<string | null>;
  /** 释放所有资源。 */
  closeAll?(): MaybePromise<void>;
}

/**
 * `createAgent` 的配置项：装配 Agent 所需的全部输入。
 * 仅 `model` 必填，其余均可选，按需挂接会话、工具、观察者、压缩器与各类钩子。
 */
export interface CreateAgentOptions<TContext = unknown> {
  /** 目标模型（必填）。 */
  readonly model: AgentModel;
  /** Agent 名称，用于日志与诊断。 */
  readonly name?: string;
  /** 系统指令（基础系统提示）。 */
  readonly instructions?: string;
  /** provider 模型设置（温度等）。 */
  readonly modelSettings?: Record<string, unknown>;
  /** 自定义模型适配器，覆盖按 `model` 解析出的默认适配器（测试常用）。 */
  readonly modelAdapter?: ModelAdapter;
  /** 运行环境（文件系统、shell、资源）。 */
  readonly environment?: AgentEnvironment;
  /** 可用工具集合。 */
  readonly tools?: readonly AnyAgentTool[];
  /** 会话存储，启用历史持久化。 */
  readonly session?: SessionStore;
  /** 运行观察者列表。 */
  readonly observers?: readonly AgentObserver<TContext>[];
  /** 会话压缩器。 */
  readonly compactor?: SessionCompactor<TContext>;
  /** Agent 元数据。 */
  readonly metadata?: Record<string, unknown>;
  /** 会话窗口：限制送入模型的最大消息条数。 */
  readonly sessionWindow?: { readonly maxMessages: number };
  /** 输入预算：最大输入 token 与为输出预留的 token。 */
  readonly modelInputBudget?: {
    readonly maxInputTokens: number;
    readonly reservedOutputTokens?: number;
  };
  /** 模型输入装配钩子：系统段、消息变换、provider 选项与最终 prepare。 */
  readonly modelInput?: {
    /** 动态系统段。 */
    readonly systemSections?: readonly SystemSection<TContext>[];
    /** 消息变换链。 */
    readonly messageTransforms?: readonly MessageTransform<TContext>[];
    /** provider 选项解析器。 */
    readonly providerOptions?: ProviderOptionsResolver<TContext>;
    /** 最终整体改写钩子。 */
    readonly prepare?: PrepareModelInput<TContext>;
  };
}
