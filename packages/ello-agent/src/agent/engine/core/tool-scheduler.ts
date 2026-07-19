/**
 * core 工具调度器模块。
 *
 * 模型适配器只负责把模型输出归一化成标准 tool call；本模块在此之上承担工具的
 * 审批判定、执行、错误归一化以及 tool-result 消息构造，是「模型决定调用什么」
 * 与「框架如何真正执行」之间的唯一汇聚点。审批被拦截在执行之前，确保需要批准
 * 的工具不会先于人工决定就被执行。
 */

import { normalizeAgentError } from '../api/errors.js';
import type {
  AgentApprovalDecision,
  AgentEnvironment,
  AgentMessage,
  AgentToolCall,
  AgentToolContext,
  AnyAgentTool,
  DeferredApprovalItem,
  DeferredToolCallItem,
} from '../api/types.js';

import { createToolResultMessage } from './tool-messages.js';

/** 构造 {@link ToolScheduler} 的入参。 */
export interface ToolSchedulerOptions {
  /** 当前 run 的标识，注入到每次工具执行的上下文中。 */
  readonly runId: string;
  readonly turnIndex: () => number;
  /** 本 run 可用的全部工具，按名建索引后供调度查找。 */
  readonly tools: readonly AnyAgentTool[];
  /** 模型实际可以发起的名称；隐藏目标仍在 tools 中供代理调用。 */
  readonly callableToolNames: ReadonlySet<string>;
  /** 工具运行所处的环境（文件系统、shell、资源等）。 */
  readonly environment: AgentEnvironment;
  /** 透传给工具上下文的元数据。 */
  readonly metadata: Record<string, unknown>;
  readonly signal: AbortSignal;
}

/** 调度过程中的事件回调集合，由调用方提供以转发为运行事件。 */
export interface ToolSchedulerEventSink {
  /** 某个工具开始执行时触发。 */
  onToolStarted(
    toolCallId: string,
    name: string,
    input: unknown,
  ): Promise<void>;
  /** 某个工具需要人工审批、被挂起时触发。 */
  onApprovalRequired(item: {
    readonly kind: 'approval';
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input?: unknown;
    readonly reason?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<void>;
  /** deferred 工具已持久化调用，等待宿主回填结果。 */
  onToolDeferred(item: DeferredToolCallItem): Promise<void>;
  /** 某个工具执行成功时触发，携带其输出。 */
  onToolCompleted(toolCallId: string, output: unknown): Promise<void>;
  /** 某个工具执行失败时触发，携带错误。 */
  onToolFailed(toolCallId: string, error: Error): Promise<void>;
}

/** 一批 tool call 调度后的结果。 */
export interface ToolScheduleResult {
  /** 已执行（成功/失败/拒绝）工具对应的 tool-result 消息。 */
  readonly messages: AgentMessage[];
  /** 已执行工具的 tool call 记录（含输出或归一化错误）。 */
  readonly toolCalls: AgentToolCall[];
  /** 因需要审批而挂起、尚未执行的工具项。 */
  readonly pending: Array<DeferredApprovalItem | DeferredToolCallItem>;
}

/**
 * core 工具调度器。
 *
 * 模型 adapter 只负责返回标准 toolCalls；scheduler 负责审批、执行、结果
 * 归一化和 tool-result message 构造。
 */
export class ToolScheduler {
  /** 工具名到工具实现的索引，便于按名查找。 */
  private readonly byName: Map<string, AnyAgentTool>;

  constructor(private readonly options: ToolSchedulerOptions) {
    this.byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  /**
   * 顺序执行一批模型返回的 tool call。
   *
   * 对每个 call 依次做：未知工具 → 失败；审批策略判定为拒绝 → 拒绝；判定为需审批
   * → 挂起进 `pending` 且不执行；否则执行并收集结果。成功、失败、拒绝都会生成相应
   * 的 tool-result 消息，使下一回合模型能看到每次调用的结果。
   */
  async schedule(
    calls: readonly AgentToolCall[],
    sink: ToolSchedulerEventSink,
  ): Promise<ToolScheduleResult> {
    const messages: AgentMessage[] = [];
    const toolCalls: AgentToolCall[] = [];
    const pending: ToolScheduleResult['pending'] = [];
    const deferredCalls = calls.filter((call) => {
      const tool = this.options.callableToolNames.has(call.name)
        ? this.byName.get(call.name)
        : undefined;
      return tool?.execution === 'deferred';
    });
    if (deferredCalls.length > 0 && calls.length !== 1) {
      const error = new Error(
        'Deferred tools must be the only tool call in a model response; no calls in this batch were executed.',
      );
      for (const call of calls) {
        await sink.onToolStarted(call.id, call.name, call.input);
        await sink.onToolFailed(call.id, error);
        toolCalls.push({ ...call, error: normalizeAgentError(error) });
        messages.push(
          createToolResultMessage(call, { error: error.message }, 'error'),
        );
      }
      return { messages, toolCalls, pending };
    }
    if (deferredCalls.length === 1) {
      const call = deferredCalls[0]!;
      const tool = this.byName.get(call.name);
      if (tool === undefined || tool.execution !== 'deferred') {
        throw new Error(`Deferred tool registry mismatch: ${call.name}`);
      }
      let input: unknown;
      try {
        input = tool.input.parse(call.input);
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        await sink.onToolStarted(call.id, call.name, call.input);
        await sink.onToolFailed(call.id, normalized);
        toolCalls.push({ ...call, error: normalizeAgentError(normalized) });
        messages.push(
          createToolResultMessage(call, { error: normalized.message }, 'error'),
        );
        return { messages, toolCalls, pending };
      }
      const item: DeferredToolCallItem = {
        kind: 'tool-call',
        toolCallId: call.id,
        toolName: call.name,
        input,
      };
      pending.push(item);
      toolCalls.push({ ...call, input });
      await sink.onToolDeferred(item);
      return { messages, toolCalls, pending };
    }
    for (const call of calls) {
      const tool = this.options.callableToolNames.has(call.name)
        ? this.byName.get(call.name)
        : undefined;
      // 模型可能臆造出不存在的工具名：记为失败并回灌错误结果，而非直接抛出中断整批。
      if (tool === undefined) {
        const error = new Error(`Unknown tool: ${call.name}`);
        await sink.onToolStarted(call.id, call.name, call.input);
        await sink.onToolFailed(call.id, error);
        toolCalls.push({ ...call, error: normalizeAgentError(error) });
        messages.push(
          createToolResultMessage(call, { error: error.message }, 'error'),
        );
        continue;
      }
      if (tool.execution !== 'immediate') {
        throw new Error(`Deferred tool escaped batch preflight: ${call.name}`);
      }
      let input: unknown;
      try {
        input = tool.input.parse(call.input);
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        await sink.onToolStarted(call.id, call.name, call.input);
        await sink.onToolFailed(call.id, normalized);
        toolCalls.push({ ...call, error: normalizeAgentError(normalized) });
        messages.push(
          createToolResultMessage(call, { error: normalized.message }, 'error'),
        );
        continue;
      }
      const ctx = this.createContext(call.id);
      // 执行前先跑工具自带的审批策略（若有），据其结果决定拒绝 / 挂起 / 放行。
      let decision: ReturnType<typeof normalizeApprovalDecision>;
      try {
        decision = normalizeApprovalDecision(await tool.approval?.(input, ctx));
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        await sink.onToolStarted(call.id, call.name, call.input);
        await sink.onToolFailed(call.id, normalized);
        toolCalls.push({
          ...call,
          input,
          error: normalizeAgentError(normalized),
        });
        messages.push(
          createToolResultMessage(call, { error: normalized.message }, 'error'),
        );
        continue;
      }
      if (decision.action === 'denied') {
        const error = new Error(
          decision.reason ??
            `Tool '${call.name}' was denied by approval policy.`,
        );
        await sink.onToolStarted(call.id, call.name, call.input);
        await sink.onToolFailed(call.id, error);
        toolCalls.push({ ...call, input, error: normalizeAgentError(error) });
        messages.push(
          createToolResultMessage(
            call,
            { denied: true, reason: error.message },
            'denied',
          ),
        );
        continue;
      }
      // 需要人工审批：仅入队挂起并通知，不执行，等待产品层批准后再重放。
      if (decision.action === 'required') {
        const item = {
          kind: 'approval' as const,
          toolCallId: call.id,
          toolName: call.name,
          input,
          reason: decision.reason ?? `Tool '${call.name}' requires approval.`,
          ...(decision.metadata !== undefined
            ? { metadata: decision.metadata }
            : {}),
        };
        pending.push(item);
        await sink.onToolStarted(call.id, call.name, input);
        await sink.onApprovalRequired(item);
        continue;
      }
      // 放行：正常执行工具，捕获异常并归一化，单个工具失败不影响整批其余调用。
      await sink.onToolStarted(call.id, call.name, input);
      try {
        const output = await tool.execute(input, ctx);
        await sink.onToolCompleted(call.id, output);
        toolCalls.push({ ...call, input, output });
        messages.push(createToolResultMessage(call, output));
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        await sink.onToolFailed(call.id, normalized);
        toolCalls.push({
          ...call,
          input,
          error: normalizeAgentError(normalized),
        });
        messages.push(
          createToolResultMessage(call, { error: normalized.message }, 'error'),
        );
      }
    }
    return { messages, toolCalls, pending };
  }

  /**
   * 执行已经被产品层批准的 deferred tool call。
   *
   * approval resume 走这里会跳过 approval preflight，但仍保留 started /
   * completed / failed 事件，保证批准后的工具执行仍归属 core scheduler。
   */
  async executeApproved(
    call: AgentToolCall,
    sink: ToolSchedulerEventSink,
  ): Promise<AgentToolCall> {
    const tool = this.options.callableToolNames.has(call.name)
      ? this.byName.get(call.name)
      : undefined;
    if (tool === undefined) {
      const error = new Error(`Unknown tool: ${call.name}`);
      await sink.onToolFailed(call.id, error);
      return { ...call, error: normalizeAgentError(error) };
    }
    if (tool.execution !== 'immediate') {
      const error = new Error(
        `Deferred tool '${call.name}' cannot be executed as an approved tool.`,
      );
      await sink.onToolFailed(call.id, error);
      return { ...call, error: normalizeAgentError(error) };
    }
    let input: unknown;
    try {
      input = tool.input.parse(call.input);
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      await sink.onToolStarted(call.id, call.name, call.input);
      await sink.onToolFailed(call.id, normalized);
      return { ...call, error: normalizeAgentError(normalized) };
    }
    await sink.onToolStarted(call.id, call.name, input);
    try {
      const output = await tool.execute(input, this.createContext(call.id));
      await sink.onToolCompleted(call.id, output);
      return { ...call, input, output };
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      await sink.onToolFailed(call.id, normalized);
      return { ...call, input, error: normalizeAgentError(normalized) };
    }
  }

  /** 构造工具执行上下文。 */
  private createContext(toolCallId: string): AgentToolContext {
    return {
      runId: this.options.runId,
      turnIndex: this.options.turnIndex(),
      toolCallId,
      environment: this.options.environment,
      metadata: { ...this.options.metadata },
      signal: this.options.signal,
    };
  }
}

function normalizeApprovalDecision(
  decision: AgentApprovalDecision | undefined,
): {
  action: 'auto' | 'required' | 'denied';
  reason?: string;
  metadata?: Record<string, unknown>;
} {
  if (decision === undefined) {
    return { action: 'auto' };
  }
  if (typeof decision === 'string') {
    return { action: decision };
  }
  return {
    action: decision.action,
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    ...(decision.metadata !== undefined ? { metadata: decision.metadata } : {}),
  };
}
