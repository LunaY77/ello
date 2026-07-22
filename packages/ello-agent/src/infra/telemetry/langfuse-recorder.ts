/**
 * 把 engine 事件流严格投影为 Langfuse/OpenTelemetry span。
 *
 * Recorder 按 run sequence 验证事件连续性，并拥有 run、turn、model、tool span 的完整生命周期。
 * Langfuse attribute 名称和 usage 序列化与该投影共同变化，因此在本文件内集中定义。
 */
import { SpanStatusCode, type Span } from '@opentelemetry/api';

import type {
  AgentEventRecorder,
  AgentUsage,
  EngineEvent,
} from '../../features/agent/engine/index.js';

import { contentAttributes } from './content-policy.js';
import {
  startChildSpan,
  type LangfuseTracingRuntime,
} from './langfuse-runtime.js';

const LANGFUSE_ATTRIBUTES = {
  traceName: 'langfuse.trace.name',
  sessionId: 'session.id',
  observationType: 'langfuse.observation.type',
  observationModel: 'langfuse.observation.model.name',
  observationUsage: 'langfuse.observation.usage_details',
} as const;

/**
 * 构造 基础设施层的 `langfuse-recorder` 模块 中的 `createLangfuseEventRecorder` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `input`: `createLangfuseEventRecorder` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `createLangfuseEventRecorder` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 基础设施层的 `langfuse-recorder` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createLangfuseEventRecorder(input: {
  readonly runtime: LangfuseTracingRuntime;
  readonly agentKind: 'primary' | 'subagent' | 'internal';
}): AgentEventRecorder {
  const recorder = new LangfuseEventRecorder(input.runtime, input.agentKind);
  return {
    record: (event, ctx) => recorder.record(event, ctx),
    flush: (ctx) => recorder.flush(ctx.runId),
  };
}

class LangfuseEventRecorder {
  private readonly runs = new Map<string, Span>();
  private readonly turns = new Map<string, Span>();
  private readonly models = new Map<string, Span>();
  private readonly tools = new Map<string, Span>();
  private readonly lastSequence = new Map<string, number>();

  constructor(
    private readonly runtime: LangfuseTracingRuntime,
    private readonly agentKind: 'primary' | 'subagent' | 'internal',
  ) {}

  record(
    event: EngineEvent,
    ctx: {
      readonly runId: string;
      readonly agentName: string;
      readonly metadata: Record<string, unknown>;
    },
  ): void {
    const previous = this.lastSequence.get(event.runId);
    if (previous !== undefined && event.sequence !== previous + 1) {
      throw new Error(
        `Trace event sequence is not contiguous for ${event.runId}: ${event.sequence}`,
      );
    }
    this.lastSequence.set(event.runId, event.sequence);
    switch (event.type) {
      case 'run.started':
        this.startRun(event, ctx);
        return;
      case 'turn.started':
        this.startTurn(event);
        return;
      case 'model.started':
        this.startModel(event);
        return;
      case 'model.first_token':
        this.require(this.models, event.identity.modelCallId, 'model').addEvent(
          'model.first_token',
          {},
          new Date(event.occurredAt),
        );
        return;
      case 'model.completed':
        this.completeModel(event);
        return;
      case 'model.failed':
        this.failModel(event);
        return;
      case 'tool.started':
        this.startTool(event);
        return;
      case 'tool.approval_requested':
        this.require(this.tools, event.request.toolCallId, 'tool').addEvent(
          'approval.requested',
          {},
          new Date(event.occurredAt),
        );
        return;
      case 'approval.required':
        this.require(this.tools, event.item.toolCallId, 'tool').addEvent(
          'approval.required',
          {},
          new Date(event.occurredAt),
        );
        this.end(
          this.require(this.tools, event.item.toolCallId, 'tool'),
          event.occurredAt,
        );
        this.tools.delete(event.item.toolCallId);
        return;
      case 'tool.deferred':
        return;
      case 'tool.completed':
        this.completeTool(event);
        return;
      case 'tool.failed':
        this.failTool(event);
        return;
      case 'turn.completed':
        this.end(
          this.require(
            this.turns,
            turnKey(event.runId, event.turnIndex),
            'turn',
          ),
          event.occurredAt,
        );
        this.turns.delete(turnKey(event.runId, event.turnIndex));
        return;
      case 'run.completed':
      case 'run.interrupted':
      case 'run.failed':
        this.endRun(event);
        return;
      case 'context.compaction':
        this.recordCompaction(event);
        return;
      case 'queue.drained':
      case 'message.started':
      case 'message.delta':
        return;
    }
  }

  async flush(runId: string): Promise<void> {
    if (
      this.runs.has(runId) ||
      [...this.turns.keys()].some((key) => key.startsWith(`${runId}:`))
    ) {
      throw new Error(`Trace recorder flushed before run closed: ${runId}`);
    }
    await this.runtime.forceFlush(runId);
  }

  /**
   * 为一次稳定请求启动独立 Agent run，并把事件流与最终结果的观察权交给调用方。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - Promise 兑现为独立 `AgentRun`；其事件流与 `result` 覆盖该运行的完整生命周期。
   *
   * Throws:
   * - 当 基础设施层的 `langfuse-recorder` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  private startRun(
    event: Extract<EngineEvent, { type: 'run.started' }>,
    ctx: {
      readonly runId: string;
      readonly agentName: string;
      readonly metadata: Record<string, unknown>;
    },
  ): void {
    const relation = this.runtime.consumeChildRun(event.runId);
    const span = (() => {
      if (relation === undefined) {
        return this.runtime.tracer.startSpan(`agent.${ctx.agentName}`, {
          startTime: new Date(event.occurredAt),
        });
      }
      const parent = this.require(
        this.tools,
        relation.parentToolCallId,
        'parent tool',
      );
      return startChildSpan(
        this.runtime.tracer,
        `agent.subagent.${relation.agentName}`,
        parent,
        event.occurredAt,
      );
    })();
    span.setAttributes({
      [LANGFUSE_ATTRIBUTES.traceName]: `ello.${ctx.agentName}`,
      [LANGFUSE_ATTRIBUTES.observationType]: 'agent',
      [LANGFUSE_ATTRIBUTES.sessionId]: this.runtime.sessionId,
      'ello.run.id': event.runId,
      'ello.agent.kind': this.agentKind,
      'ello.agent.name': ctx.agentName,
      'ello.metadata': JSON.stringify(ctx.metadata),
    });
    this.runs.set(event.runId, span);
  }

  private startTurn(
    event: Extract<EngineEvent, { type: 'turn.started' }>,
  ): void {
    const run = this.require(this.runs, event.runId, 'run');
    const span = startChildSpan(
      this.runtime.tracer,
      'agent.turn',
      run,
      event.occurredAt,
    );
    span.setAttribute(LANGFUSE_ATTRIBUTES.observationType, 'span');
    span.setAttribute('ello.turn.index', event.turnIndex);
    this.turns.set(turnKey(event.runId, event.turnIndex), span);
  }

  private startModel(
    event: Extract<EngineEvent, { type: 'model.started' }>,
  ): void {
    const turn = this.require(
      this.turns,
      turnKey(event.runId, event.identity.turnIndex),
      'turn',
    );
    const span = startChildSpan(
      this.runtime.tracer,
      `llm.${event.identity.provider}/${event.identity.model}`,
      turn,
      event.occurredAt,
    );
    span.setAttributes({
      [LANGFUSE_ATTRIBUTES.observationType]: 'generation',
      [LANGFUSE_ATTRIBUTES.observationModel]: event.identity.model,
      'ello.model.call.id': event.identity.modelCallId,
      'ello.model.provider': event.identity.provider,
      'ello.model.turn.index': event.identity.turnIndex,
      'ello.model.fingerprints': JSON.stringify(event.diagnostics),
      ...contentAttributes(this.runtime.config.content, 'input', event.request),
    });
    this.models.set(event.identity.modelCallId, span);
  }

  private completeModel(
    event: Extract<EngineEvent, { type: 'model.completed' }>,
  ): void {
    const span = this.require(this.models, event.identity.modelCallId, 'model');
    span.setAttributes({
      [LANGFUSE_ATTRIBUTES.observationUsage]: usageAttribute(
        event.response.usage,
      ),
      'ello.model.finish_reason': event.response.finishReason,
      ...contentAttributes(
        this.runtime.config.content,
        'output',
        event.response,
      ),
    });
    this.end(span, event.occurredAt);
    this.models.delete(event.identity.modelCallId);
  }

  private failModel(
    event: Extract<EngineEvent, { type: 'model.failed' }>,
  ): void {
    const span = this.require(this.models, event.identity.modelCallId, 'model');
    this.fail(span, event.error, event.occurredAt);
    this.models.delete(event.identity.modelCallId);
  }

  private startTool(
    event: Extract<EngineEvent, { type: 'tool.started' }>,
  ): void {
    const turn = this.require(
      this.turns,
      turnKey(event.runId, event.turnIndex),
      'turn',
    );
    const span = startChildSpan(
      this.runtime.tracer,
      `tool.${event.name}`,
      turn,
      event.occurredAt,
    );
    span.setAttributes({
      [LANGFUSE_ATTRIBUTES.observationType]: 'tool',
      'ello.tool.call.id': event.toolCallId,
      'ello.tool.name': event.name,
      'ello.tool.turn.index': event.turnIndex,
      ...contentAttributes(this.runtime.config.content, 'input', event.input),
    });
    this.tools.set(event.toolCallId, span);
  }

  private completeTool(
    event: Extract<EngineEvent, { type: 'tool.completed' }>,
  ): void {
    const span = this.require(this.tools, event.toolCallId, 'tool');
    span.setAttributes(
      contentAttributes(this.runtime.config.content, 'output', event.output),
    );
    this.end(span, event.occurredAt);
    this.tools.delete(event.toolCallId);
  }

  private failTool(event: Extract<EngineEvent, { type: 'tool.failed' }>): void {
    const span = this.require(this.tools, event.toolCallId, 'tool');
    this.fail(span, event.error, event.occurredAt);
    this.tools.delete(event.toolCallId);
  }

  private recordCompaction(
    event: Extract<EngineEvent, { type: 'context.compaction' }>,
  ): void {
    const run = this.require(this.runs, event.runId, 'run');
    const span = startChildSpan(
      this.runtime.tracer,
      'context.compaction',
      run,
      event.occurredAt,
    );
    span.setAttributes({
      [LANGFUSE_ATTRIBUTES.observationType]: 'span',
      'ello.compaction.before_message_count': event.beforeMessageCount,
      'ello.compaction.after_message_count': event.afterMessageCount,
      'ello.compaction.compactor': event.compactor,
      ...(event.metadata === undefined
        ? {}
        : { 'ello.compaction.metadata': JSON.stringify(event.metadata) }),
    });
    this.end(span, event.occurredAt);
  }

  private endRun(
    event: Extract<
      EngineEvent,
      { type: 'run.completed' | 'run.interrupted' | 'run.failed' }
    >,
  ): void {
    const openModels = [...this.models.keys()];
    const openTools = [...this.tools.keys()];
    if (openModels.length > 0 || openTools.length > 0) {
      throw new Error(
        `Run ${event.runId} ended with open spans: models=${openModels.join(',')}, tools=${openTools.join(',')}`,
      );
    }
    const span = this.require(this.runs, event.runId, 'run');
    if (event.type === 'run.failed') {
      this.fail(span, event.error, event.occurredAt);
    } else {
      if (event.type === 'run.completed') {
        span.setAttribute(
          LANGFUSE_ATTRIBUTES.observationUsage,
          usageAttribute(event.usage),
        );
        span.setAttribute('ello.run.finish_reason', event.finishReason);
      } else {
        span.setAttribute('ello.run.finish_reason', 'interrupted');
      }
      this.end(span, event.occurredAt);
    }
    this.runs.delete(event.runId);
  }

  private end(span: Span, occurredAt: string): void {
    span.end(new Date(occurredAt));
  }

  private fail(
    span: Span,
    error: { readonly name: string; readonly message: string },
    occurredAt: string,
  ): void {
    span.recordException({ name: error.name, message: error.message });
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    this.end(span, occurredAt);
  }

  private require(map: Map<string, Span>, key: string, kind: string): Span {
    const span = map.get(key);
    if (span === undefined) {
      throw new Error(`Unknown ${kind} span: ${key}`);
    }
    return span;
  }
}

function turnKey(runId: string, turnIndex: number): string {
  return `${runId}:${turnIndex}`;
}

/**
 * 把 engine usage 映射为 Langfuse generation usage_details。
 *
 * Args:
 * - `usage`: 已由 engine 校验的稳定 token 统计。
 *
 * Returns:
 * - 返回 Langfuse 约定字段的 JSON 文本，字段名在 recorder 内唯一维护。
 */
function usageAttribute(usage: AgentUsage): string {
  return JSON.stringify({
    input: usage.inputTokens,
    output: usage.outputTokens,
    cache_read: usage.cacheReadTokens,
    cache_write: usage.cacheWriteTokens,
  });
}
