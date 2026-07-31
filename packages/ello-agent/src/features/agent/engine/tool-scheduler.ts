/**
 * core 工具调度器模块。
 *
 * 模型适配器只负责把模型输出归一化成标准 tool call；本模块在此之上承担工具的
 * 审批判定、执行、错误归一化以及 tool-result 消息构造，是「模型决定调用什么」
 * 与「框架如何真正执行」之间的唯一汇聚点。审批被拦截在执行前，确保需要批准
 * 的工具不会先于人工决定就被执行。
 */

import type { EnvironmentHandle } from '../../environment/index.js';

import type {
  DeferredApprovalItem,
  DeferredToolCallItem,
} from './contracts.js';
import { normalizeAgentError } from './errors.js';
import type { AgentMessage } from './model.js';
import {
  toolExecutionGateFor,
  type ToolExecutionGate,
} from './tool-execution-gate.js';
import type {
  AgentApprovalDecision,
  AgentTool,
  AgentToolCapabilities,
  AgentToolCall,
  AgentToolContext,
  AnyAgentTool,
} from './tools.js';
import {
  createToolResultMessage,
  parseToolInput,
  resolveToolCapabilities,
  validateToolInput,
} from './tools.js';

/** 构造 {@link ToolScheduler} 的入参。 */
export interface ToolSchedulerOptions {
  /** 当前 run 的标识，注入到每次工具执行的上下文中。 */
  readonly runId: string;
  /**
   * 执行 产品 Agent Agent engine 工具调度 模块 定义的 `turnIndex` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回 `turnIndex` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  readonly turnIndex: () => number;
  /** 本 run 可用的全部工具，按名建索引后供调度查找。 */
  readonly tools: readonly AnyAgentTool[];
  /** 模型实际可以发起的名称；隐藏目标仍在 tools 中供代理调用。 */
  readonly callableToolNames: ReadonlySet<string>;
  /** 工具运行所处的 Environment Handle。 */
  readonly environment: EnvironmentHandle;
  /** 透传给工具上下文的元数据。 */
  readonly metadata: Record<string, unknown>;
  readonly signal: AbortSignal;
}

/** 调度过程中的事件回调集合，由调用方提供以转发为运行事件。 */
export interface ToolSchedulerEventSink {
  /**
   * 某个工具开始执行时触发。
   *
   * Args:
   * - `toolCallId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `name`: `onToolStarted` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `input`: `onToolStarted` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 产品 Agent Agent engine 工具调度 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  onToolStarted(
    toolCallId: string,
    name: string,
    input: unknown,
    invocation?: AgentToolCapabilities & { readonly physicalName: string },
  ): Promise<void>;
  /**
   * 某个工具需要人工审批、被挂起时触发。
   *
   * Args:
   * - `item`: 要由 `onApprovalRequired` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - Promise 在 产品 Agent Agent engine 工具调度 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  onApprovalRequired(item: {
    readonly kind: 'approval';
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input?: unknown;
    readonly reason?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<void>;
  /**
   * deferred 工具已持久化调用，等待宿主回填结果。
   *
   * Args:
   * - `item`: 要由 `onToolDeferred` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - Promise 在 产品 Agent Agent engine 工具调度 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  onToolDeferred(item: DeferredToolCallItem): Promise<void>;
  /**
   * 某个工具执行成功时触发，携带其输出。
   *
   * Args:
   * - `toolCallId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `output`: `onToolCompleted` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 产品 Agent Agent engine 工具调度 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  onToolCompleted(toolCallId: string, output: unknown): Promise<void>;
  /**
   * 某个工具执行失败时触发，携带错误。
   *
   * Args:
   * - `toolCallId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `error`: 上游捕获的失败值；函数保留原始 cause 并转换为当前错误契约。
   *
   * Returns:
   * - Promise 在 产品 Agent Agent engine 工具调度 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
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

interface PreparedToolCall {
  readonly kind: 'ready';
  readonly call: AgentToolCall;
  readonly tool: AgentTool<unknown, unknown>;
  readonly input: unknown;
  readonly context: AgentToolContext;
  readonly capabilities: AgentToolCapabilities;
}

interface FailedToolCallPreparation {
  readonly kind: 'failed';
  readonly call: AgentToolCall;
  readonly input: unknown;
  readonly error: Error;
}

type ToolCallPreparation = PreparedToolCall | FailedToolCallPreparation;

/**
 * core 工具调度器。
 *
 * 模型 adapter 只负责返回标准 toolCalls；scheduler 负责审批、执行、结果
 * 归一化和 tool-result message 构造。
 */
export class ToolScheduler {
  /** 工具名到工具实现的索引，便于按名查找。 */
  private readonly byName: Map<string, AnyAgentTool>;
  private readonly executionGate: ToolExecutionGate;

  /**
   * 创建 `ToolScheduler`，由该实例独占 产品 Agent Agent engine 工具调度 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `options`: 仅作用于 `constructor ToolScheduler` 的调用选项；函数只读取该对象，不保留可变引用。
   */
  constructor(private readonly options: ToolSchedulerOptions) {
    this.byName = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.executionGate = toolExecutionGateFor(options.environment);
  }

  /**
   * 顺序执行一批模型返回的 tool call。
   *
   * 对每个 call 依次做：未知工具 → 失败；审批策略判定为拒绝 → 拒绝；判定为需审批
   * → 挂起进 `pending` 且不执行；否则执行并收集结果。成功、失败、拒绝都会生成相应
   * 的 tool-result 消息，使下一回合模型能看到每次调用的结果。
   *
   * Args:
   * - `calls`: `schedule` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `sink`: `schedule` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 产品 Agent Agent engine 工具调度 模块 的异步读取或状态变更完成后兑现为声明结果。
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
      const call = deferredCalls[0];
      if (call === undefined) {
        throw new Error('Deferred tool selection lost its only call.');
      }
      const tool = this.byName.get(call.name);
      if (tool === undefined || tool.execution !== 'deferred') {
        throw new Error(`Deferred tool registry mismatch: ${call.name}`);
      }
      let input: unknown;
      try {
        input = parseToolInput(tool.input, call.name, call.input);
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
    // 先完成参数结构校验和能力判断。后续的参数检查、审批与执行均受同一把
    // 环境级读写锁保护，使用同一环境的多个 Agent 运行也会遵守写操作的先后顺序。
    const preparations = await Promise.all(
      calls.map((call) => this.prepareCall(call)),
    );
    const outcomes = await mapWithConcurrency(
      preparations,
      maxToolConcurrency(),
      (prepared) =>
        prepared.kind === 'failed'
          ? this.failPreparedCall(prepared, sink)
          : this.runPreparedCall(prepared, sink),
    );
    for (const outcome of outcomes) {
      messages.push(...outcome.messages);
      toolCalls.push(...outcome.toolCalls);
      pending.push(...outcome.pending);
    }
    return { messages, toolCalls, pending };
  }

  private async prepareCall(call: AgentToolCall): Promise<ToolCallPreparation> {
    const tool = this.options.callableToolNames.has(call.name)
      ? this.byName.get(call.name)
      : undefined;
    if (tool === undefined) {
      return {
        kind: 'failed',
        call,
        input: call.input,
        error: new Error(`Unknown tool: ${call.name}`),
      };
    }
    if (tool.execution !== 'immediate') {
      return {
        kind: 'failed',
        call,
        input: call.input,
        error: new Error(`Deferred tool escaped batch preflight: ${call.name}`),
      };
    }
    let input: unknown;
    try {
      input = parseToolInput(tool.input, call.name, call.input);
      const baseContext = this.createContext(call.id);
      const capabilities = await resolveToolCapabilities(
        tool,
        input,
        baseContext,
      );
      if (!capabilities.enabled) {
        throw new Error(`Tool '${capabilities.logicalName}' is disabled.`);
      }
      return {
        kind: 'ready',
        call,
        tool,
        input,
        capabilities,
        context: this.createContext(call.id, capabilities, call.name),
      };
    } catch (error) {
      return {
        kind: 'failed',
        call,
        input: input ?? call.input,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  private async runPreparedCall(
    prepared: PreparedToolCall,
    sink: ToolSchedulerEventSink,
  ): Promise<ToolScheduleResult> {
    const operation = () => this.runInsideGate(prepared, sink);
    try {
      return prepared.capabilities.concurrencySafe
        ? await this.executionGate.runShared(operation, this.options.signal)
        : await this.executionGate.runExclusive(operation, this.options.signal);
    } catch (error) {
      return await this.failPreparedCall(
        {
          kind: 'failed',
          call: prepared.call,
          input: prepared.input,
          error: error instanceof Error ? error : new Error(String(error)),
        },
        sink,
      );
    }
  }

  private async runInsideGate(
    prepared: PreparedToolCall,
    sink: ToolSchedulerEventSink,
  ): Promise<ToolScheduleResult> {
    const { call, tool, input, context } = prepared;
    const messages: AgentMessage[] = [];
    const toolCalls: AgentToolCall[] = [];
    const pending: ToolScheduleResult['pending'] = [];
    try {
      await validateToolInput(tool, input, context);
    } catch (error) {
      return await this.failPreparedCall(
        {
          kind: 'failed',
          call,
          input,
          error: error instanceof Error ? error : new Error(String(error)),
        },
        sink,
      );
    }
    // 工具自身的参数检查和审批判断也在锁内完成，确保它们看到前序写操作完成后的状态。
    let decision: ReturnType<typeof normalizeApprovalDecision>;
    try {
      decision = normalizeApprovalDecision(
        await tool.approval?.(input, context),
      );
    } catch (error) {
      return await this.failPreparedCall(
        {
          kind: 'failed',
          call,
          input,
          error: error instanceof Error ? error : new Error(String(error)),
        },
        sink,
      );
    }
    if (decision.action === 'denied') {
      const error = new Error(
        decision.reason ?? `Tool '${call.name}' was denied by approval policy.`,
      );
      await sink.onToolStarted(call.id, call.name, input, context.invocation);
      await sink.onToolFailed(call.id, error);
      toolCalls.push({ ...call, input, error: normalizeAgentError(error) });
      messages.push(
        createToolResultMessage(
          call,
          { denied: true, reason: error.message },
          'denied',
        ),
      );
      return { messages, toolCalls, pending };
    }
    // 需要人工审批时，只加入待审批队列并通知上层；批准后再重新提交执行。
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
      await sink.onToolStarted(call.id, call.name, input, context.invocation);
      await sink.onApprovalRequired(item);
      return { messages, toolCalls, pending };
    }
    // 审批通过后执行工具。单个工具报错时记录失败结果，不中断同批其他调用。
    await sink.onToolStarted(call.id, call.name, input, context.invocation);
    try {
      const output = await tool.execute(input, context);
      await sink.onToolCompleted(call.id, output);
      toolCalls.push(this.recordCall(call, input, { output }, context));
      messages.push(createToolResultMessage(call, output));
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      await sink.onToolFailed(call.id, normalized);
      toolCalls.push({
        ...this.recordCall(call, input, {}, context),
        error: normalizeAgentError(normalized),
      });
      messages.push(
        createToolResultMessage(call, { error: normalized.message }, 'error'),
      );
    }
    return { messages, toolCalls, pending };
  }

  private async failPreparedCall(
    prepared: FailedToolCallPreparation,
    sink: ToolSchedulerEventSink,
  ): Promise<ToolScheduleResult> {
    await sink.onToolStarted(
      prepared.call.id,
      prepared.call.name,
      prepared.input,
    );
    await sink.onToolFailed(prepared.call.id, prepared.error);
    return {
      messages: [
        createToolResultMessage(
          prepared.call,
          { error: prepared.error.message },
          'error',
        ),
      ],
      toolCalls: [
        {
          ...prepared.call,
          input: prepared.input,
          error: normalizeAgentError(prepared.error),
        },
      ],
      pending: [],
    };
  }

  /**
   * 执行已经被产品层批准的 deferred tool call。
   *
   * approval resume 走这里会跳过 approval preflight，但仍保留 started /
   * completed / failed 事件，保证批准后的工具执行仍归属 core scheduler。
   *
   * Args:
   * - `call`: `executeApproved` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `sink`: `executeApproved` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 产品 Agent Agent engine 工具调度 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 产品 Agent Agent engine 工具调度 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async executeApproved(
    call: AgentToolCall,
    sink: ToolSchedulerEventSink,
  ): Promise<AgentToolCall> {
    const prepared = await this.prepareCall(call);
    if (prepared.kind === 'failed') {
      const failed = await this.failPreparedCall(prepared, sink);
      return failed.toolCalls[0] ?? call;
    }
    const operation = async (): Promise<AgentToolCall> => {
      try {
        await validateToolInput(
          prepared.tool,
          prepared.input,
          prepared.context,
        );
        await sink.onToolStarted(
          call.id,
          call.name,
          prepared.input,
          prepared.context.invocation,
        );
        const output = await prepared.tool.execute(
          prepared.input,
          prepared.context,
        );
        await sink.onToolCompleted(call.id, output);
        return this.recordCall(
          call,
          prepared.input,
          { output },
          prepared.context,
        );
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        await sink.onToolFailed(call.id, normalized);
        return {
          ...this.recordCall(call, prepared.input, {}, prepared.context),
          error: normalizeAgentError(normalized),
        };
      }
    };
    return prepared.capabilities.concurrencySafe
      ? await this.executionGate.runShared(operation, this.options.signal)
      : await this.executionGate.runExclusive(operation, this.options.signal);
  }

  /** 构造工具执行上下文。 */
  private createContext(
    toolCallId: string,
    capabilities?: AgentToolCapabilities,
    physicalName?: string,
  ): AgentToolContext {
    return {
      runId: this.options.runId,
      turnIndex: this.options.turnIndex(),
      toolCallId,
      environment: this.options.environment,
      metadata: { ...this.options.metadata, toolCallId },
      signal: this.options.signal,
      ...(capabilities === undefined || physicalName === undefined
        ? {}
        : { invocation: { ...capabilities, physicalName } }),
    };
  }

  private recordCall(
    call: AgentToolCall,
    input: unknown,
    result: { readonly output?: unknown },
    context: AgentToolContext,
  ): AgentToolCall {
    return {
      ...call,
      input,
      ...result,
      ...(context.invocation === undefined
        ? {}
        : {
            metadata: {
              ...(call.metadata ?? {}),
              invocation: context.invocation,
            },
          }),
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

const DEFAULT_MAX_TOOL_CONCURRENCY = 10;

/**
 * 读取单个并发段内允许同时执行的工具上限。
 *
 * Returns:
 * - 返回并发上限；环境变量缺失或非正整数时返回默认值。
 */
function maxToolConcurrency(): number {
  const configured = Number.parseInt(
    process.env.ELLO_MAX_TOOL_CONCURRENCY ?? '',
    10,
  );
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_TOOL_CONCURRENCY;
}

/**
 * 以固定并发上限映射一批输入，并按输入顺序返回结果。
 *
 * 模型单轮可以返回任意多个并发安全调用；无上限地全部同时启动会同时打满文件
 * 描述符与内存。上限只约束同时在飞的数量，不改变结果顺序。
 *
 * Args:
 * - `items`: 待处理的输入序列，结果按其下标对齐。
 * - `limit`: 同时在飞的最大任务数，必须为正整数。
 * - `run`: 单个输入的执行函数。
 *
 * Returns:
 * - Promise 兑现为与 `items` 等长、下标对齐的结果数组。
 */
async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  run: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length <= limit) {
    return await Promise.all(items.map((item) => run(item)));
  }
  const results = new Array<TResult>(items.length);
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) {
        throw new Error(`Tool call batch lost its item at index ${index}.`);
      }
      results[index] = await run(item);
    }
  });
  await Promise.all(workers);
  return results;
}
