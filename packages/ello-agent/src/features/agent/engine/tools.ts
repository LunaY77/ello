/**
 * 本文件负责 agent feature 的工具定义与执行适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */

import { tool, type ToolSet } from 'ai';
import type { z } from 'zod';

import type { AgentError } from './contracts.js';
import type { AgentEnvironment } from './contracts.js';
import { normalizeAgentError } from './errors.js';
import { createAgentMessage } from './messages.js';
import type { AgentMessage, MaybePromise, ModelCallResult } from './model.js';
import type { RunState } from './run-state.js';

export type ToolRisk = 'readonly' | 'workspace-write' | 'external';

/** 供 tool_search 和权限/展示层使用的发现元数据。 */
export interface AgentToolDiscovery {
  readonly aliases: readonly string[];
  readonly risk: ToolRisk;
  readonly core?: boolean;
}

export interface AgentApprovalRequest {
  readonly id: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

export type AgentApprovalAction = 'auto' | 'required' | 'denied';
export type AgentApprovalDecision =
  | AgentApprovalAction
  | {
      readonly action: AgentApprovalAction;
      readonly reason?: string;
      readonly metadata?: Record<string, unknown>;
    };
/**
 * 执行 产品 Agent Agent engine 工具执行 模块 定义的 `AgentApprovalPolicy` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `input`: `AgentApprovalPolicy` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
 *
 * Returns:
 * - 返回 `AgentApprovalPolicy` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export type AgentApprovalPolicy<TInput = unknown> = (
  input: TInput,
  ctx: AgentToolContext,
) => MaybePromise<AgentApprovalDecision>;

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly execution: 'immediate';
  readonly name: string;
  readonly description: string;
  /** 工具发现信息必须随工具定义声明，不能由名称或独立 registry 推断。 */
  readonly discovery: AgentToolDiscovery;
  readonly input: z.ZodType<TInput>;
  /**
   * 在 产品 Agent Agent engine 工具执行 模块 中执行 `execute` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `input`: `execute` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `execute` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 产品 Agent Agent engine 工具执行 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  execute(input: TInput, ctx: AgentToolContext): MaybePromise<TOutput>;
  /**
   * 执行 产品 Agent Agent engine 工具执行 模块 定义的 `approval` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `input`: `approval` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `approval` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  approval?(
    input: TInput,
    ctx: AgentToolContext,
  ): MaybePromise<AgentApprovalDecision>;
  readonly inherit?: boolean;
}

export interface DeferredAgentTool<TInput = unknown> {
  readonly execution: 'deferred';
  readonly name: string;
  readonly description: string;
  readonly discovery: AgentToolDiscovery;
  readonly input: z.ZodType<TInput>;
  readonly inherit?: boolean;
}

export type AnyAgentTool =
  | AgentTool<unknown, unknown>
  | DeferredAgentTool<unknown>;

export interface AgentToolContext {
  readonly runId: string;
  readonly turnIndex: number;
  readonly toolCallId: string;
  readonly environment: AgentEnvironment;
  readonly metadata: Record<string, unknown>;
  readonly signal: AbortSignal;
}

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: AgentError;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentSkill {
  readonly name: string;
  readonly description: string;
  readonly source: 'global' | 'project';
  readonly baseDir: string;
  readonly realPath: string;
  readonly skillPath: string;
  readonly contentHash: string;
  readonly instructions: string;
  readonly metadata?: Record<string, unknown>;
}

export interface DefineToolOptions<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly discovery: AgentToolDiscovery;
  readonly input: z.ZodType<TInput>;
  /**
   * 在 产品 Agent Agent engine 工具执行 模块 中执行 `execute` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `input`: `execute` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
   *
   * Returns:
   * - 返回 `execute` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 产品 Agent Agent engine 工具执行 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  readonly execute: (
    input: TInput,
    ctx: AgentToolContext,
  ) => MaybePromise<TOutput>;
  readonly approval?: AgentTool<TInput, TOutput>['approval'];
}

/**
 * 定义类型由 Zod schema 推导的 Agent 工具。
 *
 * Args:
 * - `options`: 仅作用于 `defineTool` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回 `defineTool` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function defineTool<TInput, TOutput>(
  options: DefineToolOptions<TInput, TOutput>,
): AgentTool<TInput, TOutput> {
  return {
    execution: 'immediate',
    name: options.name,
    description: options.description,
    discovery: options.discovery,
    input: options.input,
    execute: options.execute,
    ...(options.approval !== undefined ? { approval: options.approval } : {}),
  };
}

/**
 * 定义可放入 heterogeneous 工具集合的 Agent 工具。
 *
 * Args:
 * - `options`: schema 与实现共享同一输入类型；schema 是擦除后恢复具体输入的唯一运行时边界。
 *
 * Returns:
 * - 返回输入已安全擦除为 `unknown` 的工具；执行和审批前都会用原 schema 重新解析。
 */
export function defineAnyTool<TInput, TOutput>(
  options: DefineToolOptions<TInput, TOutput>,
): AnyAgentTool {
  const approval = options.approval;
  return {
    execution: 'immediate',
    name: options.name,
    description: options.description,
    discovery: options.discovery,
    input: options.input,
    execute: (input, ctx) => options.execute(options.input.parse(input), ctx),
    ...(approval === undefined
      ? {}
      : {
          approval: (input: unknown, ctx: AgentToolContext) =>
            approval(options.input.parse(input), ctx),
        }),
  };
}

export interface DefineDeferredToolOptions<TInput> {
  readonly name: string;
  readonly description: string;
  readonly discovery: AgentToolDiscovery;
  readonly input: z.ZodType<TInput>;
}

/**
 * 定义由宿主回填结果、不会在 Agent 进程内执行的工具。
 *
 * Args:
 * - `options`: 仅作用于 `defineDeferredTool` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回 `defineDeferredTool` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function defineDeferredTool<TInput>(
  options: DefineDeferredToolOptions<TInput>,
): DeferredAgentTool<TInput> {
  return { execution: 'deferred', ...options };
}

export interface BuildToolSetOptions {
  readonly tools: ReadonlyArray<AnyAgentTool>;
}

export class AgentApprovalRequiredError extends Error {
  override readonly name = 'AgentApprovalRequiredError';
  readonly kind = 'approval-required';

  /**
   * 创建 `AgentApprovalRequiredError`，由该实例独占 产品 Agent Agent engine 工具执行 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `toolCallId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `toolName`: `constructor AgentApprovalRequiredError` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `input`: `constructor AgentApprovalRequiredError` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   */
  constructor(
    readonly toolCallId: string,
    readonly toolName: string,
    readonly input: unknown,
  ) {
    super(`Tool '${toolName}' requires approval.`);
  }
}

/**
 * 把 engine 工具定义转换成只暴露 schema 的 AI SDK ToolSet。
 *
 * Args:
 * - `options.tools`: 模型可见的工具定义；名称必须唯一且非空。
 *
 * Returns:
 * - 返回不包含 execute 的 ToolSet，实际执行只经过 ToolScheduler。
 */
export function buildToolSet(options: BuildToolSetOptions): ToolSet {
  const result: ToolSet = {};
  const tools = [...options.tools].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const agentTool of tools) {
    if (result[agentTool.name] !== undefined) {
      throw new Error(`Duplicate agent tool name: ${agentTool.name}`);
    }
    result[agentTool.name] = tool({
      description: agentTool.description,
      inputSchema: agentTool.input,
    });
  }
  return result;
}

export type ToolResultStatus = 'success' | 'error' | 'denied';

/**
 * 构造 产品 Agent Agent engine 工具执行 模块 中的 `createToolCallMessage` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `call`: `createToolCallMessage` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `createToolCallMessage` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent Agent engine 工具执行 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createToolCallMessage(call: {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}): AgentMessage {
  return createAgentMessage({
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.name,
        input: toJsonValue(call.input),
      },
    ],
  });
}

/**
 * 构造 产品 Agent Agent engine 工具执行 模块 中的 `createToolResultMessage` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `call`: `createToolResultMessage` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `output`: `createToolResultMessage` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `status`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
 *
 * Returns:
 * - 返回 `createToolResultMessage` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent Agent engine 工具执行 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createToolResultMessage(
  call: Pick<AgentToolCall, 'id' | 'name' | 'input'>,
  output: unknown,
  status: ToolResultStatus = 'success',
): AgentMessage {
  return createAgentMessage({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: call.id,
        toolName: call.name,
        output: createToolOutput(output, status),
      },
    ],
  });
}

/**
 * 执行 产品 Agent Agent engine 工具执行 模块 定义的 `missingToolResultIds` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `messages`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 */
export function missingToolResultIds(
  messages: ReadonlyArray<AgentMessage>,
): ReadonlyArray<string> {
  const pending = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    if (message.role === 'assistant') {
      for (const part of message.content) {
        const id = toolPartId(part, 'tool-call');
        if (id !== undefined) pending.add(id);
      }
    } else if (message.role === 'tool') {
      for (const part of message.content) {
        const id = toolPartId(part, 'tool-result');
        if (id !== undefined) pending.delete(id);
      }
    }
  }
  return [...pending];
}

/**
 * 执行 产品 Agent Agent engine 工具执行 模块 定义的 `collectToolCallIds` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `messages`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `collectToolCallIds` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function collectToolCallIds(
  messages: ReadonlyArray<AgentMessage>,
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      const id = toolPartId(part, 'tool-call');
      if (id !== undefined) ids.add(id);
    }
  }
  return ids;
}

export interface ToolExecutionResult {
  readonly messages: AgentMessage[];
  readonly toolCalls: AgentToolCall[];
  readonly pendingCount: number;
}

/**
 * 调度模型本回合返回的工具调用并发布工具生命周期事件。
 *
 * Args:
 * - `run`: 当前 run 的 scheduler、deferred queue 和事件发布器。
 * - `assistant`: 本回合模型调用结果。
 *
 * Returns:
 * - 返回追加到历史的工具结果消息、工具调用快照和待处理数量。
 */
export async function executeToolCalls(
  run: RunState,
  assistant: ModelCallResult,
): Promise<ToolExecutionResult> {
  const toolCallsFromModel = assistant.response?.toolCalls ?? [];
  if (toolCallsFromModel.length === 0) {
    return { messages: [], toolCalls: [], pendingCount: 0 };
  }
  const scheduled = await run.toolScheduler.schedule(toolCallsFromModel, {
    onToolStarted: (toolCallId, name, input) =>
      run.events.emit({
        type: 'tool.started',
        turnIndex: run.state.turn,
        toolCallId,
        name,
        input,
      }),
    onApprovalRequired: async (item) => {
      await run.events.emit({
        type: 'tool.approval_requested',
        turnIndex: run.state.turn,
        request: {
          id: item.toolCallId,
          toolCallId: item.toolCallId,
          name: item.toolName,
          input: item.input,
          ...(item.reason === undefined ? {} : { reason: item.reason }),
          ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
        },
      });
      const pending = run.runControl.deferredQueue
        .snapshot()
        .some(
          (entry) =>
            entry.kind === 'approval' && entry.toolCallId === item.toolCallId,
        );
      if (!pending) {
        run.runControl.pushDeferred(item);
        await run.events.emit({ type: 'approval.required', item });
      }
    },
    onToolDeferred: async (item) => {
      const pending = run.runControl.deferredQueue
        .snapshot()
        .some(
          (entry) =>
            entry.kind === 'tool-call' && entry.toolCallId === item.toolCallId,
        );
      if (!pending) {
        run.runControl.pushDeferred(item);
        await run.events.emit({ type: 'tool.deferred', item });
      }
    },
    onToolCompleted: (toolCallId, output) =>
      run.events.emit({
        type: 'tool.completed',
        turnIndex: run.state.turn,
        toolCallId,
        output,
      }),
    onToolFailed: (toolCallId, error) =>
      run.events.emit({
        type: 'tool.failed',
        turnIndex: run.state.turn,
        toolCallId,
        error: normalizeAgentError(error),
      }),
  });
  return {
    messages: scheduled.messages,
    toolCalls: scheduled.toolCalls,
    pendingCount: scheduled.pending.length,
  };
}

function toolPartId(
  part: unknown,
  type: 'tool-call' | 'tool-result',
): string | undefined {
  if (
    typeof part !== 'object' ||
    part === null ||
    Reflect.get(part, 'type') !== type
  ) {
    return undefined;
  }
  const id = Reflect.get(part, 'toolCallId');
  return typeof id === 'string' ? id : undefined;
}

function createToolOutput(output: unknown, status: ToolResultStatus): unknown {
  if (status === 'denied') {
    const reason = readReason(output);
    return {
      type: 'execution-denied',
      ...(reason === undefined ? {} : { reason }),
    };
  }
  if (status === 'error') {
    return { type: 'error-text', value: readReason(output) ?? String(output) };
  }
  if (typeof output === 'string') return { type: 'text', value: output };
  const textOutput = readStructuredTextOutput(output);
  return textOutput === undefined
    ? { type: 'json', value: toJsonValue(output) }
    : { type: 'text', value: textOutput };
}

function readReason(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const reason = Reflect.get(value, 'reason');
  const error = Reflect.get(value, 'error');
  return typeof reason === 'string'
    ? reason
    : typeof error === 'string'
      ? error
      : undefined;
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Tool value is not JSON serializable.');
  }
  return JSON.parse(serialized);
}

function readStructuredTextOutput(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, 'kind') === 'coding-tool-result' &&
    typeof Reflect.get(value, 'output') === 'string'
    ? Reflect.get(value, 'output')
    : undefined;
}
