import type { AgentEventInput, EngineEvent } from '../api/events.js';
import type {
  AgentObserver,
  AgentRunContext,
  AgentRunResult,
  AgentToolCall,
  CreateAgentOptions,
} from '../api/types.js';

import type {
  AgentTraceEvent,
  InternalAgentRunContext,
} from './runtime-types.js';
import type { AgentEventStream } from './stream.js';

/**
 * 事件分发器。
 *
 * 每条事件产生后经此「一处发出、多处投递」：写入有界 trace、推入对外事件流、
 * 回调 observer，并交给显式 recorder。
 */
export class AgentEventDispatcher {
  /** 按 toolCallId 累积工具调用信息，用于在 completed 时补全 name/input。 */
  private readonly observerToolCalls = new Map<string, AgentToolCall>();
  private sequence = 0;

  constructor(
    private readonly config: CreateAgentOptions,
    private readonly stream: AgentEventStream,
    private readonly ctx: InternalAgentRunContext,
  ) {}

  /**
   * 发出一条事件，扇出到各消费方。
   *
   * 实时事件先进入 stream，再执行会影响 run 的 observer 与 recorder。
   */
  async emit(input: AgentEventInput): Promise<void> {
    const event = this.enrich(input);
    this.recordTrace(event);
    this.stream.emit(event);
    await this.emitObserverEvent(event);
    await this.config.eventRecorder?.record(event, this.ctx);
  }

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

  async fail(
    event: Extract<AgentEventInput, { type: 'run.failed' }>,
  ): Promise<Extract<EngineEvent, { type: 'run.failed' }>> {
    const emitted = this.enrich(event) as Extract<
      EngineEvent,
      { type: 'run.failed' }
    >;
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
    return {
      ...input,
      runId: this.ctx.runId,
      sequence: ++this.sequence,
      occurredAt: new Date().toISOString(),
    } as EngineEvent;
  }

  private recordTrace(event: EngineEvent): void {
    const diagnostic = toTraceEvent(event, this.ctx.runId);
    if (diagnostic === null) {
      return;
    }
    const events = this.ctx.trace.events;
    if (events.length === TRACE_EVENT_CAPACITY) {
      events.shift();
    }
    events.push(diagnostic);
  }

  /** 把事件投递给所有 observer。 */
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
      return {
        type: event.type,
        runId: event.runId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        toolCallId: event.item.toolCallId,
        toolName: event.item.toolName,
      };
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
    case 'run.completed':
      return event;
    case 'context.compaction':
      return null;
    case 'run.failed':
      return {
        type: event.type,
        runId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        errorName: event.error.name,
        errorMessage: event.error.message,
      };
    case 'model.started':
    case 'model.first_token':
    case 'model.completed':
    case 'model.failed':
    case 'queue.drained':
    case 'message.started':
    case 'message.delta':
      return null;
  }
}

/**
 * 把单条事件映射到对应的 observer 回调。
 *
 * 按事件类型分派到 `onRunStarted` / `onTurnStarted` / `onToolScheduled` 等；
 * 工具相关事件借助 `toolCalls` 映射跨 started/completed 关联同一次调用，
 * 以便在 completed 时回填 started 阶段记录的 name 与 input。
 */
async function emitSingleObserverEvent(
  observer: AgentObserver,
  event: EngineEvent,
  ctx: AgentRunContext,
  toolCalls: Map<string, AgentToolCall>,
): Promise<void> {
  if (event.type === 'run.started') {
    await observer.onRunStarted?.({ runId: event.runId }, ctx);
    return;
  }
  if (event.type === 'turn.started') {
    await observer.onTurnStarted?.(
      { runId: event.runId, turnIndex: event.turnIndex },
      ctx,
    );
    return;
  }
  if (event.type === 'tool.started') {
    // 记下本次调用的 name/input，completed 时据 toolCallId 回填。
    const call = {
      id: event.toolCallId,
      name: event.name,
      input: event.input,
    };
    toolCalls.set(event.toolCallId, call);
    await observer.onToolScheduled?.(call, ctx);
    return;
  }
  if (event.type === 'approval.required') {
    await observer.onToolApprovalRequired?.(event.item, ctx);
    return;
  }
  if (event.type === 'tool.deferred') {
    return;
  }
  if (event.type === 'tool.completed') {
    const started = toolCalls.get(event.toolCallId);
    if (started === undefined) {
      throw new Error(`Tool completed before start: ${event.toolCallId}`);
    }
    const completed = {
      id: event.toolCallId,
      name: started.name,
      input: started.input,
      output: event.output,
    };
    toolCalls.set(event.toolCallId, completed);
    await observer.onToolCompleted?.(completed, ctx);
    return;
  }
  if (event.type === 'run.failed') {
    await observer.onRunFailed?.({ error: event.error }, ctx);
    return;
  }
}

/**
 * 释放环境持有的资源。
 *
 * 环境负责聚合并释放自己持有的资源，内核只调用统一的 `close` 生命周期入口。
 */
export async function closeAgentResources(
  environment: CreateAgentOptions['environment'],
): Promise<void> {
  await environment?.close?.();
}
