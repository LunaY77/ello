/**
 * 本文件负责 provider ToolSet、tool-call transcript 与 Command Run 适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */

import { jsonSchema, tool, type ToolSet } from 'ai';
import type { z } from 'zod';

import type {
  CommandRunCheckpoint,
  CommandRunTransition,
  PendingCommandInteraction,
} from '../../command/index.js';

import type { AgentError } from './contracts.js';
import { normalizeAgentError } from './errors.js';
import { createAgentMessage } from './messages.js';
import type { AgentMessage, ModelCallResult } from './model.js';
import type { RunState } from './run-state.js';

export type AgentToolInputJsonSchema = Exclude<
  Parameters<typeof jsonSchema>[0],
  PromiseLike<unknown> | (() => unknown)
>;

export interface AgentApprovalRequest {
  readonly id: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
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

export interface BuildToolSetOptions {
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly input: z.ZodType<unknown>;
    readonly inputJsonSchema?: AgentToolInputJsonSchema;
  }>;
}

/**
 * 把 engine 工具定义转换成只暴露 schema 的 AI SDK ToolSet。
 *
 * Args:
 * - `options.tools`: 模型可见的工具定义；名称必须唯一且非空。
 *
 * Returns:
 * - 返回不包含 execute 的 ToolSet，实际执行只经过 CommandRunRuntime。
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
      inputSchema:
        agentTool.inputJsonSchema === undefined
          ? agentTool.input
          : jsonSchema(agentTool.inputJsonSchema),
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
  if (
    toolCallsFromModel.length !== 1 ||
    toolCallsFromModel[0]?.name !== 'command_run'
  ) {
    return rejectInvalidCommandRunBatch(toolCallsFromModel);
  }
  const outer = toolCallsFromModel[0];
  if (outer === undefined) throw new Error('Command Run call disappeared.');
  const execution = run.config.commandRun.start({
    providerToolCallId: outer.id,
    input: outer.input,
    context: commandRunContext(run),
  });
  const transition = await consumeCommandRun(run, execution);
  return transitionResult(run, outer, transition);
}

/** 恢复同一 outer command_run，并在恢复过程中继续发布内部 Command 事件。 */
export async function resumeCommandRun(
  run: RunState,
  checkpoint: CommandRunCheckpoint,
  approvals:
    | Readonly<
        Record<
          string,
          boolean | { readonly approved: boolean; readonly reason?: string }
        >
      >
    | undefined,
  toolResults: Readonly<Record<string, unknown>> | undefined,
): Promise<
  | { readonly type: 'completed'; readonly output: unknown }
  | { readonly type: 'suspended' }
> {
  const execution = run.config.commandRun.resume({
    checkpoint,
    ...(approvals === undefined ? {} : { approvals }),
    ...(toolResults === undefined ? {} : { toolResults }),
    context: commandRunContext(run),
  });
  const transition = await consumeCommandRun(run, execution);
  if (transition.type === 'suspended') {
    await registerCommandInteractions(run, transition);
    return { type: 'suspended' };
  }
  return {
    type: 'completed',
    output: transition.observation,
  };
}

function commandRunContext(run: RunState) {
  return {
    runId: run.runId,
    turnIndex: run.state.turn,
    environment: run.environment,
    metadata: run.metadata,
    signal: run.signal,
  } as const;
}

async function consumeCommandRun(
  run: RunState,
  execution: import('../../command/index.js').CommandRunExecution,
): Promise<CommandRunTransition> {
  for await (const event of execution) {
    await run.events.emit({ type: 'command.event', event });
  }
  return execution.result;
}

async function transitionResult(
  run: RunState,
  outer: AgentToolCall,
  transition: CommandRunTransition,
): Promise<ToolExecutionResult> {
  if (transition.type === 'suspended') {
    await registerCommandInteractions(run, transition);
    return {
      messages: [],
      toolCalls: [{ ...outer, input: outer.input }],
      pendingCount: transition.interactions.length,
    };
  }
  return {
    messages: [createToolResultMessage(outer, transition.observation)],
    toolCalls: [{ ...outer, output: transition.observation }],
    pendingCount: 0,
  };
}

async function registerCommandInteractions(
  run: RunState,
  transition: Extract<CommandRunTransition, { type: 'suspended' }>,
): Promise<void> {
  for (const interaction of transition.interactions) {
    const item = deferredItem(interaction, transition.checkpoint);
    if (
      run.runControl.deferredQueue
        .snapshot()
        .some((entry) =>
          entry.kind === 'interrupted'
            ? false
            : entry.toolCallId === item.toolCallId,
        )
    ) {
      continue;
    }
    run.runControl.pushDeferred(item);
    await run.events.emit(
      item.kind === 'approval'
        ? { type: 'approval.required', item }
        : { type: 'tool.deferred', item },
    );
  }
}

function deferredItem(
  interaction: PendingCommandInteraction,
  checkpoint: CommandRunCheckpoint,
):
  | import('./contracts.js').DeferredApprovalItem
  | import('./contracts.js').DeferredToolCallItem {
  const common = {
    toolCallId: interaction.commandId,
    commandName: interaction.commandName,
    input: interaction.input,
    commandRunCheckpoint: checkpoint,
  };
  return interaction.kind === 'approval'
    ? {
        kind: 'approval',
        ...common,
        ...(interaction.reason === undefined
          ? {}
          : { reason: interaction.reason }),
        ...(interaction.metadata === undefined
          ? {}
          : { metadata: interaction.metadata }),
      }
    : { kind: 'tool-call', ...common };
}

function rejectInvalidCommandRunBatch(
  calls: readonly AgentToolCall[],
): ToolExecutionResult {
  const message =
    calls.length === 1
      ? `Unknown provider tool '${calls[0]?.name ?? ''}'; only command_run is callable.`
      : `A model response must contain at most one command_run call; received ${calls.length}. No commands were executed. Retry with exactly one command_run Tool Call and merge every batch into its commands array, using step values for dependency groups.`;
  return {
    messages: calls.map((call) =>
      createToolResultMessage(call, { error: message }, 'error'),
    ),
    toolCalls: calls.map((call) => ({
      ...call,
      error: normalizeAgentError(new Error(message)),
    })),
    pendingCount: 0,
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
  return Reflect.get(value, 'kind') === 'command-result' &&
    typeof Reflect.get(value, 'output') === 'string'
    ? Reflect.get(value, 'output')
    : undefined;
}
