/**
 * 本文件负责 agent feature 的模型调用契约。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { randomUUID } from 'node:crypto';

import type {
  JSONValue,
  LanguageModel,
  LanguageModelCallOptions,
  ModelMessage as AiModelMessage,
  ToolChoice,
  ToolSet,
} from 'ai';

import type {
  AgentFinishReason,
  AgentRunContext,
  AgentUsage,
} from './contracts.js';
import { ModelAdapterProtocolError, normalizeAgentError } from './errors.js';
import { interruptRunState, type RunState } from './run-state.js';
import type { AgentToolCall } from './tools.js';

export type AgentMessage = AiModelMessage;
export type UserMessage = Extract<AiModelMessage, { role: 'user' }>;
export type AssistantMessage = Extract<AiModelMessage, { role: 'assistant' }>;
export type AgentModel = string | LanguageModel;
export type AgentModelSettings = LanguageModelCallOptions;
export interface AgentProviderOptionObject {
  [key: string]: JSONValue | undefined;
}
export type AgentProviderOptions = Record<string, AgentProviderOptionObject>;
export type AgentToolSet = ToolSet;
export type AgentToolChoice = ToolChoice<ToolSet>;

export interface ModelInput {
  readonly system?: string;
  readonly messages: AgentMessage[];
  readonly tools: AgentToolSet;
  readonly activeTools?: readonly string[];
  readonly toolChoice?: AgentToolChoice;
  readonly providerOptions?: AgentProviderOptions;
  readonly diagnostics?: ModelInputDiagnostics;
}

export interface ModelInputDiagnostics {
  readonly systemSections: number;
  readonly messageCount: number;
  readonly estimatedInputTokens?: number;
  readonly activeTools?: readonly string[];
  readonly hasProviderOptions: boolean;
  readonly appliedMessageTransforms: readonly string[];
  readonly systemFingerprint: string;
  readonly toolsetFingerprint: string;
  readonly messagePrefixFingerprint: string;
  readonly compactionBoundary: boolean;
}

/**
 * 执行 产品 Agent Agent engine 模型调用 模块 定义的 `SystemSection` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `run`: `SystemSection` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
 */
export type SystemSection<TContext = unknown> = (
  run: AgentRunContext<TContext>,
) => MaybePromise<string | null | undefined>;

/**
 * 执行 产品 Agent Agent engine 模型调用 模块 定义的 `MessageTransform` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `messages`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 * - `run`: `MessageTransform` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 */
export type MessageTransform<TContext = unknown> = (
  messages: readonly AgentMessage[],
  run: AgentRunContext<TContext>,
) => MaybePromise<readonly AgentMessage[]>;

/**
 * 执行 产品 Agent Agent engine 模型调用 模块 定义的 `ProviderOptionsResolver` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `run`: `ProviderOptionsResolver` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
 */
export type ProviderOptionsResolver<TContext = unknown> = (
  run: AgentRunContext<TContext>,
) => MaybePromise<AgentProviderOptions | null | undefined>;

/**
 * 在 产品 Agent Agent engine 模型调用 模块 中执行 `PrepareModelInput` 完整流程，并在返回前完成其必要副作用。
 *
 * Args:
 * - `input`: `PrepareModelInput` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 * - `run`: `PrepareModelInput` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `PrepareModelInput` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export type PrepareModelInput<TContext = unknown> = (
  input: ModelInput,
  run: AgentRunContext<TContext>,
) => MaybePromise<ModelInput>;

export interface AgentModelRequest {
  readonly runId: string;
  readonly model: AgentModel;
  readonly system?: string;
  readonly messages: AgentMessage[];
  readonly tools: ToolSet;
  readonly activeTools?: readonly string[];
  readonly toolChoice?: AgentToolChoice;
  readonly providerOptions?: AgentProviderOptions;
  readonly modelSettings: AgentModelSettings;
  readonly signal?: AbortSignal;
}

export interface AgentModelResponse {
  readonly text: string;
  readonly messages: AgentMessage[];
  readonly newMessages: AgentMessage[];
  readonly toolCalls?: AgentToolCall[];
  readonly toolResults?: unknown[];
  readonly usage: AgentUsage;
  readonly finishReason: AgentFinishReason;
  readonly provider: unknown;
}

export type AgentModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'final'; response: AgentModelResponse };

export interface ModelAdapter {
  /**
   * 在 产品 Agent Agent engine 模型调用 模块 中执行 `generate` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `request`: 进入 产品 Agent Agent engine 模型调用 模块 的稳定请求；校验后只读传递，不由函数修改。
   *
   * Returns:
   * - Promise 在 产品 Agent Agent engine 模型调用 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  generate(request: AgentModelRequest): Promise<AgentModelResponse>;
  /**
   * 启动 产品 Agent Agent engine 模型调用 模块 的流式执行，并按产生顺序交付增量事件与终态。
   *
   * Args:
   * - `request`: 进入 产品 Agent Agent engine 模型调用 模块 的稳定请求；校验后只读传递，不由函数修改。
   *
   * Returns:
   * - 返回当前调用独占的异步事件流；迭代在发布终态后结束，生产失败会使迭代抛错。
   */
  stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent>;
}

export type MaybePromise<T> = T | Promise<T>;

export interface ModelCallResult {
  readonly response?: AgentModelResponse;
  readonly stopReason?: 'interrupted';
}

/**
 * 执行一次模型调用并发布完整生命周期事件。
 *
 * Args:
 * - `run`: 当前 run 状态、事件发布器和模型 adapter。
 * - `input`: 已完成 system、message、tool 与 provider option 装配的模型输入。
 *
 * Returns:
 * - 返回最终模型响应；中断时只返回 `stopReason`。
 *
 * Throws:
 * - 当 adapter 违反 final event 协议或模型调用失败时直接抛错。
 */
export async function callModel(
  run: RunState,
  input: ModelInput,
): Promise<ModelCallResult> {
  if (run.signal.aborted) {
    interruptRunState(run);
    return { stopReason: 'interrupted' };
  }
  const messageId = randomUUID();
  await run.events.emit({
    type: 'message.started',
    turnIndex: run.state.turn,
    messageId,
    role: 'assistant',
  });
  const request = createModelRequest(run, input);
  const identity = {
    ...modelIdentity(run.config.model),
    runId: run.runId,
    turnIndex: run.state.turn,
    modelCallId: randomUUID(),
  };
  const diagnostics = input.diagnostics;
  if (diagnostics === undefined) {
    throw new Error('Model input diagnostics are required for model calls.');
  }
  await run.events.emit({
    type: 'model.started',
    identity,
    request,
    diagnostics: modelCallDiagnostics(diagnostics),
  });
  const startedAt = new Date().toISOString();
  let firstTokenAt: string | undefined;
  let finalResponse: AgentModelResponse | null = null;
  let emittedTextDelta = false;
  try {
    for await (const event of run.modelAdapter.stream(request)) {
      if (finalResponse !== null) {
        throw new ModelAdapterProtocolError(
          event.type === 'final'
            ? 'Model adapter emitted more than one final event.'
            : 'Model adapter emitted an event after the final event.',
        );
      }
      switch (event.type) {
        case 'text-delta':
          if (firstTokenAt === undefined) {
            firstTokenAt = new Date().toISOString();
            await run.events.emit({ type: 'model.first_token', identity });
          }
          await run.events.emit({
            type: 'message.delta',
            turnIndex: run.state.turn,
            messageId,
            text: event.text,
          });
          emittedTextDelta = true;
          break;
        case 'final':
          finalResponse = event.response;
          break;
        default:
          event satisfies never;
          throw new Error(`Unhandled model event: ${String(event)}`);
      }
    }
    if (finalResponse === null) {
      throw new ModelAdapterProtocolError(
        'Model adapter stream ended without a final event.',
      );
    }
    if (!emittedTextDelta && finalResponse.text !== '') {
      await run.events.emit({
        type: 'message.delta',
        turnIndex: run.state.turn,
        messageId,
        text: finalResponse.text,
      });
    }
    await run.events.emit({
      type: 'model.completed',
      identity,
      response: finalResponse,
      diagnostics: modelCallDiagnostics(diagnostics),
      startedAt,
      ...(firstTokenAt === undefined ? {} : { firstTokenAt }),
    });
    return { response: finalResponse };
  } catch (error) {
    if (run.signal.aborted || isAbortError(error)) {
      interruptRunState(run);
      return { stopReason: 'interrupted' };
    }
    await run.events.emit({
      type: 'model.failed',
      identity,
      error: normalizeAgentError(error),
      diagnostics: modelCallDiagnostics(diagnostics),
      startedAt,
    });
    throw error;
  }
}

function modelCallDiagnostics(
  diagnostics: ModelInputDiagnostics,
): Pick<
  ModelInputDiagnostics,
  | 'systemFingerprint'
  | 'toolsetFingerprint'
  | 'messagePrefixFingerprint'
  | 'compactionBoundary'
> {
  return {
    systemFingerprint: diagnostics.systemFingerprint,
    toolsetFingerprint: diagnostics.toolsetFingerprint,
    messagePrefixFingerprint: diagnostics.messagePrefixFingerprint,
    compactionBoundary: diagnostics.compactionBoundary,
  };
}

function modelIdentity(model: AgentModel): {
  readonly provider: string;
  readonly model: string;
} {
  if (typeof model === 'string') {
    const separator = model.includes('/') ? '/' : ':';
    const [provider, ...modelParts] = model.split(separator);
    if (provider === undefined || provider === '' || modelParts.length === 0) {
      throw new Error(`Invalid string model identity: ${model}`);
    }
    return { provider, model: modelParts.join(separator) };
  }
  if (
    typeof model.provider !== 'string' ||
    model.provider === '' ||
    typeof model.modelId !== 'string' ||
    model.modelId === ''
  ) {
    throw new Error('Language model must expose provider and modelId.');
  }
  return { provider: model.provider, model: model.modelId };
}

function createModelRequest(
  run: RunState,
  input: ModelInput,
): AgentModelRequest {
  return {
    runId: run.runId,
    model: run.config.model,
    ...(input.system === undefined ? {} : { system: input.system }),
    messages: input.messages,
    tools: input.tools,
    ...(input.activeTools === undefined
      ? {}
      : { activeTools: input.activeTools }),
    ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
    ...(input.providerOptions === undefined
      ? {}
      : { providerOptions: input.providerOptions }),
    modelSettings: {
      ...(run.config.modelSettings ?? {}),
      ...(run.options.modelSettings ?? {}),
    },
    signal: run.signal,
  };
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}
