/**
 * 本文件负责 agent feature 的事件联合与发布契约。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type {
  AgentError,
  AgentEnvironment,
  AgentFinishReason,
  AgentRunContext,
  AgentRunResult,
  AgentUsage,
  CreateAgentOptions,
  DeferredApprovalItem,
  DeferredToolCallItem,
} from './contracts.js';
import type {
  AgentMessage,
  AgentModelRequest,
  AgentModelResponse,
  MaybePromise,
} from './model.js';
import type { AgentTraceEvent, InternalAgentRunContext } from './run-state.js';
import type { AgentEventStream } from './stream.js';
import type { AgentApprovalRequest, AgentToolCall } from './tools.js';

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

export interface AgentObserver<TContext = unknown> {
  /**
   * 处理 产品 Agent Agent engine 事件 模块 的 `onRunStarted` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `onRunStarted` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  onRunStarted?(
    event: { readonly runId: string },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /**
   * 处理 产品 Agent Agent engine 事件 模块 的 `onTurnStarted` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `onTurnStarted` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  onTurnStarted?(
    event: { readonly runId: string; readonly turnIndex: number },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /**
   * 处理 产品 Agent Agent engine 事件 模块 的 `onToolScheduled` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `onToolScheduled` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  onToolScheduled?(
    event: AgentToolCall,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /**
   * 处理 产品 Agent Agent engine 事件 模块 的 `onToolApprovalRequired` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `onToolApprovalRequired` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  onToolApprovalRequired?(
    event: DeferredApprovalItem,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /**
   * 处理 产品 Agent Agent engine 事件 模块 的 `onToolCompleted` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `onToolCompleted` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  onToolCompleted?(
    event: AgentToolCall,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /**
   * 处理 产品 Agent Agent engine 事件 模块 的 `onRunCompleted` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `result`: 用于完成唯一待处理操作的结果；同一结果不得重复消费。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `onRunCompleted` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  onRunCompleted?(
    result: AgentRunResult,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /**
   * 处理 产品 Agent Agent engine 事件 模块 的 `onRunFailed` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `onRunFailed` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  onRunFailed?(
    event: { readonly error: AgentError },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
}

export interface MessageCompactionResult {
  readonly messages: ReadonlyArray<AgentMessage>;
  readonly report: import('./contracts.js').MessageCompactionReport;
}

export interface MessageCompactor {
  readonly name: string;
  /**
   * 在 产品 Agent Agent engine 事件 模块 中执行 `compact` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `input`: `compact` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  compact(input: {
    readonly messages: ReadonlyArray<AgentMessage>;
    readonly contextWindow: number;
    readonly signal: AbortSignal;
  }): MaybePromise<MessageCompactionResult | null>;
}

export interface AgentEventRecorder<TContext = unknown> {
  /**
   * 按 产品 Agent Agent engine 事件 模块 的一致性约束执行 `record` 状态变更。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `record` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  record(
    event: EngineEvent,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  /**
   * 在 产品 Agent Agent engine 事件 模块 中执行 `flush` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `flush` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  flush?(ctx: AgentRunContext<TContext>): MaybePromise<void>;
}

export class AgentEventDispatcher {
  private readonly observerToolCalls = new Map<string, AgentToolCall>();
  private sequence = 0;

  /**
   * 创建 `AgentEventDispatcher`，由该实例独占 产品 Agent Agent engine 事件 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
   * - `stream`: `constructor AgentEventDispatcher` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   */
  constructor(
    private readonly config: CreateAgentOptions,
    private readonly stream: AgentEventStream,
    private readonly ctx: InternalAgentRunContext,
  ) {}

  /**
   * 处理 产品 Agent Agent engine 事件 模块 的 `emit` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `input`: `emit` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 产品 Agent Agent engine 事件 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async emit(input: AgentEventInput): Promise<void> {
    const event = this.enrich(input);
    this.recordTrace(event);
    this.stream.emit(event);
    await this.emitObserverEvent(event);
    await this.config.eventRecorder?.record(event, this.ctx);
  }

  /**
   * 在 产品 Agent Agent engine 事件 模块 中执行 `complete` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `result`: 用于完成唯一待处理操作的结果；同一结果不得重复消费。
   *
   * Returns:
   * - Promise 在 产品 Agent Agent engine 事件 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async complete(result: AgentRunResult): Promise<void> {
    await this.emit({
      type: 'run.completed',
      finishReason: result.finishReason,
      usage: result.usage,
    });
    await this.config.eventRecorder?.flush?.(this.ctx);
    for (const observer of this.config.observers ?? []) {
      await observer.onRunCompleted?.(result, this.ctx);
    }
  }

  /**
   * 在 产品 Agent Agent engine 事件 模块 中执行 `fail` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   *
   * Returns:
   * - Promise 在 产品 Agent Agent engine 事件 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async fail(
    event: Extract<AgentEventInput, { type: 'run.failed' }>,
  ): Promise<Extract<EngineEvent, { type: 'run.failed' }>> {
    const emitted = this.enrich(event);
    if (emitted.type !== 'run.failed') {
      throw new Error(`Expected run.failed event, received ${emitted.type}.`);
    }
    this.recordTrace(emitted);
    await this.emitObserverEvent(emitted);
    await this.config.eventRecorder?.record(emitted, this.ctx);
    await this.config.eventRecorder?.flush?.(this.ctx);
    return emitted;
  }

  private enrich(input: AgentEventInput): EngineEvent {
    if (input.runId !== undefined && input.runId !== this.ctx.runId) {
      throw new Error(
        `Event runId does not match dispatcher context: ${input.runId}`,
      );
    }
    // WHY: distributive `Omit` 保留每个事件 variant，但对象 spread 后 TypeScript 无法恢复 type 与 payload 的关联。
    // SCOPE: 只在 dispatcher 注入统一 metadata 的这一处桥接为闭合 `EngineEvent`。
    // SAFETY: `AgentEventInput` 从 `EngineEvent` 派生，runId 冲突已校验，事件消费者对 type 做穷举测试。
    return {
      ...input,
      runId: this.ctx.runId,
      sequence: ++this.sequence,
      occurredAt: new Date().toISOString(),
    } as EngineEvent;
  }

  private recordTrace(event: EngineEvent): void {
    const diagnostic = toTraceEvent(event, this.ctx.runId);
    if (diagnostic === null) return;
    if (this.ctx.trace.events.length === TRACE_EVENT_CAPACITY) {
      this.ctx.trace.events.shift();
    }
    this.ctx.trace.events.push(diagnostic);
  }

  private async emitObserverEvent(event: EngineEvent): Promise<void> {
    for (const observer of this.config.observers ?? []) {
      await emitSingleObserverEvent(
        observer,
        event,
        this.ctx,
        this.observerToolCalls,
      );
    }
  }
}

const TRACE_EVENT_CAPACITY = 1_024;

function toTraceEvent(
  event: EngineEvent,
  runId: string,
): AgentTraceEvent | null {
  switch (event.type) {
    case 'run.started':
    case 'turn.started':
    case 'turn.completed':
    case 'run.completed':
      return event;
    case 'tool.started':
      return {
        type: event.type,
        runId: event.runId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        toolCallId: event.toolCallId,
        name: event.name,
      };
    case 'tool.approval_requested':
      return {
        type: event.type,
        runId: event.runId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        toolCallId: event.request.toolCallId,
        toolName: event.request.name,
      };
    case 'approval.required':
    case 'tool.deferred':
      return {
        type: event.type,
        runId: event.runId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        toolCallId: event.item.toolCallId,
        toolName: event.item.toolName,
      };
    case 'tool.completed':
      return {
        type: event.type,
        runId: event.runId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        toolCallId: event.toolCallId,
      };
    case 'tool.failed':
      return {
        type: event.type,
        runId: event.runId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        toolCallId: event.toolCallId,
        errorName: event.error.name,
        errorMessage: event.error.message,
      };
    case 'run.interrupted':
      return {
        type: event.type,
        runId: event.runId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
      };
    case 'run.failed':
      return {
        type: event.type,
        runId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        errorName: event.error.name,
        errorMessage: event.error.message,
      };
    case 'context.compaction':
    case 'model.started':
    case 'model.first_token':
    case 'model.completed':
    case 'model.failed':
    case 'queue.drained':
    case 'message.started':
    case 'message.delta':
      return null;
    default:
      event satisfies never;
      throw new Error(`Unhandled engine event: ${String(event)}`);
  }
}

async function emitSingleObserverEvent(
  observer: AgentObserver,
  event: EngineEvent,
  ctx: AgentRunContext,
  toolCalls: Map<string, AgentToolCall>,
): Promise<void> {
  switch (event.type) {
    case 'run.started':
      await observer.onRunStarted?.({ runId: event.runId }, ctx);
      return;
    case 'turn.started':
      await observer.onTurnStarted?.(
        { runId: event.runId, turnIndex: event.turnIndex },
        ctx,
      );
      return;
    case 'tool.started': {
      const call = {
        id: event.toolCallId,
        name: event.name,
        input: event.input,
      };
      toolCalls.set(event.toolCallId, call);
      await observer.onToolScheduled?.(call, ctx);
      return;
    }
    case 'approval.required':
      await observer.onToolApprovalRequired?.(event.item, ctx);
      return;
    case 'tool.completed': {
      const started = toolCalls.get(event.toolCallId);
      if (started === undefined) {
        throw new Error(`Tool completed before start: ${event.toolCallId}`);
      }
      const completed = { ...started, output: event.output };
      toolCalls.set(event.toolCallId, completed);
      await observer.onToolCompleted?.(completed, ctx);
      return;
    }
    case 'run.failed':
      await observer.onRunFailed?.({ error: event.error }, ctx);
      return;
    case 'turn.completed':
    case 'queue.drained':
    case 'message.started':
    case 'message.delta':
    case 'model.started':
    case 'model.first_token':
    case 'model.completed':
    case 'model.failed':
    case 'tool.approval_requested':
    case 'tool.deferred':
    case 'tool.failed':
    case 'context.compaction':
    case 'run.interrupted':
    case 'run.completed':
      return;
    default:
      event satisfies never;
      throw new Error(`Unhandled observer event: ${String(event)}`);
  }
}

/**
 * 执行 产品 Agent Agent engine 事件 模块 定义的 `closeAgentResources` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `environment`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
 *
 * Returns:
 * - Promise 在 产品 Agent Agent engine 事件 模块 的异步副作用完整提交后兑现，不返回业务值。
 *
 * Throws:
 * - 当 产品 Agent Agent engine 事件 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function closeAgentResources(
  environment: AgentEnvironment,
): Promise<void> {
  await environment.close?.();
}
