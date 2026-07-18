/**
 * Vercel AI SDK 模型适配器。
 *
 * 把框架的标准 {@link AgentModelRequest} 翻译成 AI SDK 的 `generateText` /
 * `streamText` 调用，并把其响应（文本、消息、tool call、用量、结束原因）反向
 * 归一化回框架的标准响应形态。这是框架默认依赖具体 provider 的唯一位置——核心
 * 循环只面向 {@link ModelAdapter} 接口编程，替换此适配器即可接入测试桩或私有模型服务。
 */

import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI, openai } from '@ai-sdk/openai';
import {
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from 'ai';

import type {
  AgentFinishReason,
  AgentModel,
  AgentModelEvent,
  AgentModelRequest,
  AgentModelResponse,
  ModelAdapter,
} from '../../engine/api/types.js';
import { createToolCallMessage } from '../../engine/core/tool-messages.js';
import { createEmptyUsage, mapAiSdkUsage } from '../../engine/core/usage.js';

export interface AiSdkModelAdapterOptions {
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
}

/**
 * 默认 Vercel AI SDK adapter。
 *
 * 该 adapter 是 @ello/agent 与 Vercel AI SDK 的唯一默认耦合点。核心 loop
 * 面向 ModelAdapter 编程，因此测试或私有模型服务可以替换这里。
 */
export class AiSdkModelAdapter implements ModelAdapter {
  private readonly openaiProvider: typeof openai;
  private readonly anthropicProvider: typeof anthropic;

  constructor(private readonly options: AiSdkModelAdapterOptions = {}) {
    this.openaiProvider =
      options.baseURL !== undefined || options.headers !== undefined
        ? createOpenAI({
            ...(options.baseURL !== undefined
              ? { baseURL: options.baseURL }
              : {}),
            ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
            ...(options.headers !== undefined
              ? { headers: options.headers }
              : {}),
          })
        : openai;
    this.anthropicProvider =
      options.baseURL !== undefined || options.headers !== undefined
        ? createAnthropic({
            ...(options.baseURL !== undefined
              ? { baseURL: options.baseURL }
              : {}),
            ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
            ...(options.headers !== undefined
              ? { headers: options.headers }
              : {}),
          })
        : anthropic;
  }

  /**
   * 非流式模型调用。
   *
   * Args:
   *   request: 标准 AgentModelRequest。
   *
   * Returns:
   *   标准 AgentModelResponse。
   */
  async generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    const result = await generateText({
      model: this.resolveLanguageModel(request.model),
      ...(request.system !== undefined ? { system: request.system } : {}),
      messages: request.messages as ModelMessage[],
      tools: request.tools,
      ...(request.activeTools !== undefined
        ? { activeTools: request.activeTools }
        : {}),
      ...(request.toolChoice !== undefined
        ? { toolChoice: request.toolChoice }
        : {}),
      ...(request.providerOptions !== undefined
        ? { providerOptions: request.providerOptions as never }
        : {}),
      ...(request.signal !== undefined ? { abortSignal: request.signal } : {}),
      ...(request.modelSettings as object),
    });
    const newMessages = normalizeResponseMessages(
      result.responseMessages,
      result.text,
    );
    const toolCalls = normalizeToolCalls(result.toolCalls);
    return {
      text: result.text,
      messages: [...request.messages, ...newMessages],
      newMessages,
      toolCalls,
      toolResults: result.toolResults,
      usage: {
        ...mapAiSdkUsage(result.usage),
        toolCalls: toolCalls.length,
      },
      finishReason: normalizeFinishReason(result.finishReason),
      provider: result,
    };
  }

  /**
   * 流式模型调用。
   *
   * Args:
   *   request: 标准 AgentModelRequest。
   *
   * Yields:
   *   text-delta 和 final 事件。
   */
  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent> {
    const result = streamText({
      model: this.resolveLanguageModel(request.model),
      ...(request.system !== undefined ? { system: request.system } : {}),
      messages: request.messages as ModelMessage[],
      tools: request.tools,
      onError: () => undefined,
      ...(request.activeTools !== undefined
        ? { activeTools: request.activeTools }
        : {}),
      ...(request.toolChoice !== undefined
        ? { toolChoice: request.toolChoice }
        : {}),
      ...(request.providerOptions !== undefined
        ? { providerOptions: request.providerOptions as never }
        : {}),
      ...(request.signal !== undefined ? { abortSignal: request.signal } : {}),
      ...(request.modelSettings as object),
    });
    let text = '';
    const pendingMirrorText: string[] = [];
    let bufferingPotentialMirror = true;
    let usage = createEmptyUsage();
    let finishReason: AgentFinishReason = 'unknown';
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text;
        if (bufferingPotentialMirror) {
          pendingMirrorText.push(part.text);
          bufferingPotentialMirror = canBecomeToolCallMirror(text);
          if (!bufferingPotentialMirror) {
            for (const delta of pendingMirrorText) {
              yield { type: 'text-delta', text: delta };
            }
            pendingMirrorText.length = 0;
          }
        } else {
          yield { type: 'text-delta', text: part.text };
        }
      } else if (part.type === 'tool-call') {
        toolCalls.push(readToolCall(part));
      } else if (part.type === 'finish') {
        usage = mapAiSdkUsage(part.totalUsage);
        finishReason = normalizeFinishReason(part.finishReason);
      } else if (part.type === 'error') {
        throw part.error;
      }
    }
    const textIsToolCallMirror = isToolCallMirrorText(text, toolCalls);
    const newMessages =
      toolCalls.length > 0
        ? createStreamToolCallMessages(await result.responseMessages, toolCalls)
        : normalizeResponseMessages(await result.responseMessages, text);
    if (!textIsToolCallMirror && pendingMirrorText.length > 0) {
      for (const delta of pendingMirrorText) {
        yield { type: 'text-delta', text: delta };
      }
    }
    yield {
      type: 'final',
      response: {
        text: textIsToolCallMirror ? '' : text,
        messages: [...request.messages, ...newMessages],
        newMessages,
        toolCalls,
        toolResults: [],
        usage: { ...usage, toolCalls: toolCalls.length },
        finishReason:
          toolCalls.length > 0 && finishReason === 'stop'
            ? 'tool-calls'
            : finishReason,
        provider: result,
      },
    };
  }

  private resolveLanguageModel(model: AgentModel): LanguageModel {
    return resolveLanguageModel(model, {
      openaiProvider: this.openaiProvider,
      anthropicProvider: this.anthropicProvider,
    });
  }
}

function createStreamToolCallMessages(
  responseMessages: readonly unknown[],
  calls: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[],
): ModelMessage[] {
  const reasoningParts = responseMessages.flatMap((message) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      (message as { role?: unknown }).role !== 'assistant'
    ) {
      return [];
    }
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content)
      ? content.filter(
          (part) =>
            typeof part === 'object' &&
            part !== null &&
            (part as { type?: unknown }).type === 'reasoning',
        )
      : [];
  });
  const toolCallParts = calls.flatMap((call) => {
    const message = createToolCallMessage(call) as {
      readonly content?: unknown;
    };
    return Array.isArray(message.content) ? message.content : [];
  });
  return [
    {
      role: 'assistant',
      content: [...reasoningParts, ...toolCallParts],
    } as ModelMessage,
  ];
}

/**
 * 将 AI SDK 累计 response messages 标准化为 core 可保存的消息。
 *
 * 工具路径必须保留 assistant tool-call 和 tool-result 消息；否则下一轮模型
 * 看不到工具结果，会重复调用同一个工具直到 maxTurns。
 */
function normalizeResponseMessages(
  messages: readonly unknown[],
  text: string,
): ModelMessage[] {
  if (messages.length > 0) {
    return messages as ModelMessage[];
  }
  return text ? [{ role: 'assistant', content: text }] : [];
}

/** 把 AI SDK tool call 归一化为框架标准 `{ id, name, input }`。 */
function normalizeToolCalls(value: readonly unknown[]) {
  return value.map((item) => readToolCall(item));
}

/**
 * 将公开 model 配置解析为 AI SDK LanguageModel。
 *
 * Args:
 *   model: provider:model 字符串或已经构造好的 LanguageModel。
 *
 * Returns:
 *   Vercel AI SDK LanguageModel。
 */
export function resolveLanguageModel(
  model: AgentModel,
  providers: {
    readonly openaiProvider?: typeof openai;
    readonly anthropicProvider?: typeof anthropic;
  } = {},
): LanguageModel {
  if (typeof model !== 'string') {
    return model;
  }
  const openaiProvider = providers.openaiProvider ?? openai;
  const anthropicProvider = providers.anthropicProvider ?? anthropic;
  const [provider, ...rest] = model.split(':');
  const modelName = rest.join(':') || provider || model;
  if (provider === 'openai-chat') {
    return openaiProvider.chat(modelName as Parameters<typeof openai.chat>[0]);
  }
  if (provider === 'openai-responses' || provider === 'openai') {
    return openaiProvider.responses(
      modelName as Parameters<typeof openai.responses>[0],
    );
  }
  if (provider === 'anthropic') {
    return anthropicProvider(modelName as Parameters<typeof anthropic>[0]);
  }
  return openaiProvider(model as Parameters<typeof openai>[0]);
}

function readToolCall(value: unknown): {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
} {
  if (typeof value !== 'object' || value === null) {
    throw new Error('AI SDK tool-call part must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.type !== 'tool-call') {
    throw new Error('AI SDK tool-call part must have type "tool-call".');
  }
  if (typeof record.toolCallId !== 'string' || record.toolCallId === '') {
    throw new Error('AI SDK tool-call part is missing toolCallId.');
  }
  if (typeof record.toolName !== 'string' || record.toolName === '') {
    throw new Error('AI SDK tool-call part is missing toolName.');
  }
  if (!Object.hasOwn(record, 'input')) {
    throw new Error('AI SDK tool-call part is missing input.');
  }
  return {
    id: record.toolCallId,
    name: record.toolName,
    input: record.input,
  };
}

function isToolCallMirrorText(
  text: string,
  toolCalls: readonly { readonly id: string; readonly name: string }[],
): boolean {
  if (toolCalls.length === 0 || text.trim() === '') {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (
    items.length !== toolCalls.length ||
    items.some((item) => !isToolCallPart(item))
  ) {
    return false;
  }
  return items.every((item, index) => {
    const record = item as Record<string, unknown>;
    const expected = toolCalls[index];
    if (expected === undefined) {
      return false;
    }
    return (
      record.toolCallId === expected.id && record.toolName === expected.name
    );
  });
}

function canBecomeToolCallMirror(text: string): boolean {
  let rest = text.trimStart();
  if (rest === '') {
    return true;
  }
  if (rest.startsWith('[')) {
    rest = rest.slice(1).trimStart();
    if (rest === '') {
      return true;
    }
  }
  if (!rest.startsWith('{')) {
    return false;
  }
  rest = rest.slice(1).trimStart();
  if (rest === '') {
    return true;
  }
  const typeKey = '"type"';
  if (typeKey.startsWith(rest)) {
    return true;
  }
  if (!rest.startsWith(typeKey)) {
    return false;
  }
  rest = rest.slice(typeKey.length).trimStart();
  if (rest === '') {
    return true;
  }
  if (':'.startsWith(rest)) {
    return true;
  }
  if (!rest.startsWith(':')) {
    return false;
  }
  rest = rest.slice(1).trimStart();
  if (rest === '') {
    return true;
  }
  const toolCallValue = '"tool-call"';
  return toolCallValue.startsWith(rest) || rest.startsWith(toolCallValue);
}

function isToolCallPart(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'tool-call'
  );
}

/** 把 provider 返回的结束原因收敛到框架已知枚举，未识别值归为 `'unknown'`。 */
function normalizeFinishReason(value: unknown): AgentFinishReason {
  if (
    value === 'stop' ||
    value === 'length' ||
    value === 'tool-calls' ||
    value === 'content-filter' ||
    value === 'error'
  ) {
    return value;
  }
  return 'unknown';
}
