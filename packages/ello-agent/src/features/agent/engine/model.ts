/**
 * 本文件负责 agent feature 的模型调用契约。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type {
  JSONValue,
  Instructions,
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
import type { ModelCompactor } from './events.js';
import { interruptRunState, type RunState } from './run-state.js';
import type { AgentToolCall } from './tools.js';

export type ConversationMessage = Exclude<
  AiModelMessage,
  { readonly role: 'system' }
>;
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

/**
 * 模型调用的不可变配置身份。它在 Agent 装配时完成两级引用解析，并在每次调用事件中原样保留。
 */
export interface ModelCallConfiguration {
  readonly agentName: string;
  readonly modelSelector: 'primary_model' | 'auxiliary_model';
  readonly configuredModel: string;
  readonly protocol: 'openai' | 'anthropic' | 'openai-compatible';
  readonly apiModel: string;
}

export interface ModelInput {
  readonly instructions?: Instructions;
  readonly messages: ConversationMessage[];
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
  readonly instructions?: Instructions;
  readonly messages: ConversationMessage[];
  readonly tools: ToolSet;
  readonly activeTools?: readonly string[];
  readonly toolChoice?: AgentToolChoice;
  readonly providerOptions?: AgentProviderOptions;
  readonly modelSettings: AgentModelSettings;
  readonly signal?: AbortSignal;
}

export interface AgentModelResponse {
  readonly text: string;
  readonly messages: ConversationMessage[];
  readonly newMessages: ConversationMessage[];
  readonly toolCalls?: AgentToolCall[];
  readonly toolResults?: unknown[];
  readonly usage: AgentUsage;
  readonly finishReason: AgentFinishReason;
  readonly provider: unknown;
}

export type AgentModelEvent =
  /**
   * 模型产出的第一段内容已到达。reasoning 与 tool-call 增量不经过
   * `text-delta`，若只在 `text-delta` 上计时，纯工具轮与推理轮会完全没有首字
   * 延迟。适配器必须在首个承载模型内容的增量上恰好发出一次本事件。
   */
  | { type: 'stream-start' }
  | { type: 'reasoning-delta'; text: string }
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
  return callModelAttempt(run, input, 0);
}

/**
 * 执行单次可观察模型尝试，并对瞬时传输错误进行有界恢复。
 *
 * Args:
 * - `run`: 当前 run 状态、事件发布器和模型 adapter。
 * - `input`: 已完成 system、message、tool 与 provider option 装配的模型输入。
 * - `retryAttempt`: 已经执行的恢复次数，用于选择固定退避并限制总尝试数。
 *
 * Returns:
 * - 返回最终模型响应；中断时只返回 `stopReason`。
 */
async function callModelAttempt(
  run: RunState,
  input: ModelInput,
  retryAttempt: number,
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
    ...run.config.modelCall,
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
  let reasoningId: string | undefined;
  let reasoningText = '';
  let reasoningCompleted = false;
  const completeReasoning = async (): Promise<void> => {
    if (reasoningId === undefined || reasoningCompleted) return;
    reasoningCompleted = true;
    await run.events.emit({
      type: 'reasoning.completed',
      turnIndex: run.state.turn,
      reasoningId,
      text: reasoningText,
    });
  };
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
        case 'stream-start':
          if (firstTokenAt === undefined) {
            firstTokenAt = new Date().toISOString();
            await run.events.emit({ type: 'model.first_token', identity });
          }
          break;
        case 'text-delta':
          // 正文 delta 也可能是本轮第一个内容事件（适配器未上报 stream-start
          // 时），first-token 必须在两条路径上都成立且只计一次。
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
        case 'reasoning-delta':
          if (firstTokenAt === undefined) {
            firstTokenAt = new Date().toISOString();
            await run.events.emit({ type: 'model.first_token', identity });
          }
          if (reasoningId === undefined) {
            reasoningId = randomUUID();
            await run.events.emit({
              type: 'reasoning.started',
              turnIndex: run.state.turn,
              reasoningId,
            });
          }
          reasoningText += event.text;
          await run.events.emit({
            type: 'reasoning.delta',
            turnIndex: run.state.turn,
            reasoningId,
            text: event.text,
          });
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
    await completeReasoning();
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
    await completeReasoning();
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
    const retryDelay = MODEL_STREAM_RETRY_DELAYS_MS[retryAttempt];
    if (retryDelay !== undefined && isTransientModelError(error)) {
      if (!(await waitForModelRetry(retryDelay, run.signal))) {
        interruptRunState(run);
        return { stopReason: 'interrupted' };
      }
      return callModelAttempt(run, input, retryAttempt + 1);
    }
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

function createModelRequest(
  run: RunState,
  input: ModelInput,
): AgentModelRequest {
  return {
    runId: run.runId,
    model: run.config.model,
    ...(input.instructions === undefined
      ? {}
      : { instructions: input.instructions }),
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

/**
 * 从主 Agent 已成型的模型请求创建同模型、同 system、同 tools 和同缓存前缀的模型压缩器。
 *
 * Args:
 * - `run`: 当前主 Agent run，提供模型、adapter 和稳定调用设置。
 * - `input`: 当前主模型调用已经成型的最终输入，包含 provider cache 标记。
 *
 * Returns:
 * - 返回可在主 run 之外执行、但复用同一模型前缀的压缩器。
 */
export function createModelCompactor(
  run: RunState,
  input: ModelInput,
): ModelCompactor {
  const baseRequest = createModelRequest(run, input);
  return {
    modelCall: run.config.modelCall,
    async compact(compactInput) {
      const response = await run.modelAdapter.generate({
        ...baseRequest,
        runId: randomUUID(),
        messages: [
          ...reuseCachedMessagePrefix(
            compactInput.messages,
            baseRequest.messages,
          ),
          { role: 'user', content: compactInput.prompt },
        ],
        toolChoice: 'none',
        signal: compactInput.signal,
      });
      return { text: response.text, usage: response.usage };
    },
  };
}

function reuseCachedMessagePrefix(
  messages: ReadonlyArray<AgentMessage>,
  cached: ReadonlyArray<ConversationMessage>,
): ConversationMessage[] {
  const source = messages.filter(
    (message): message is ConversationMessage => message.role !== 'system',
  );
  const prefixLength = commonMessagePrefixLength(source, cached);
  return source.map((message, index) => {
    if (index >= prefixLength) return message;
    const cachedMessage = cached[index];
    if (cachedMessage === undefined) return message;
    return cachedMessage;
  });
}

function commonMessagePrefixLength(
  messages: ReadonlyArray<ConversationMessage>,
  cached: ReadonlyArray<ConversationMessage>,
): number {
  const length = Math.min(messages.length, cached.length);
  for (let index = 0; index < length; index += 1) {
    const message = messages[index];
    const cachedMessage = cached[index];
    if (
      message === undefined ||
      cachedMessage === undefined ||
      !isDeepStrictEqual(
        messageWithoutProviderOptions(message),
        messageWithoutProviderOptions(cachedMessage),
      )
    ) {
      return index;
    }
  }
  return length;
}

function messageWithoutProviderOptions(
  message: ConversationMessage,
): Omit<ConversationMessage, 'providerOptions'> {
  const { providerOptions: _providerOptions, ...content } = message;
  return content;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

const MODEL_STREAM_RETRY_DELAYS_MS = [250, 1_000] as const;
const TRANSIENT_MODEL_ERROR_CODES: ReadonlySet<string> = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_SOCKET',
]);

/**
 * 沿 Error cause 链识别允许重放当前无工具副作用模型请求的瞬时故障。
 *
 * Args:
 * - `error`: provider 或 HTTP runtime 抛出的原始异常。
 *
 * Returns:
 * - 明确标记 retryable、常见瞬时状态码或传输错误码时返回 `true`。
 */
function isTransientModelError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    if (Reflect.get(current, 'isRetryable') === true) return true;
    const code = Reflect.get(current, 'code');
    if (typeof code === 'string' && TRANSIENT_MODEL_ERROR_CODES.has(code)) {
      return true;
    }
    const status =
      Reflect.get(current, 'statusCode') ?? Reflect.get(current, 'status');
    if (
      typeof status === 'number' &&
      (status === 408 ||
        status === 409 ||
        status === 425 ||
        status === 429 ||
        status >= 500)
    ) {
      return true;
    }
    current = Reflect.get(current, 'cause');
  }
  return false;
}

/**
 * 等待模型重试退避，并让用户中断立即抢占等待。
 *
 * Args:
 * - `delayMs`: 本次恢复前的等待毫秒数。
 * - `signal`: 当前 run 的取消信号。
 *
 * Returns:
 * - 等待完成返回 `true`；期间收到取消返回 `false`。
 */
function waitForModelRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const complete = (result: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => complete(false);
    const timer = setTimeout(() => complete(true), delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
