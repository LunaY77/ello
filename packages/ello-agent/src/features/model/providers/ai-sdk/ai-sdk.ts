/**
 * Vercel AI SDK 模型调用与响应协议适配器。
 *
 * 把框架的标准 {@link AgentModelRequest} 翻译成 AI SDK 的 `generateText` /
 * `streamText` 调用，并把其响应（文本、消息、tool call、用量、结束原因）反向
 * 归一化回框架的标准响应形态。核心循环只面向 {@link ModelAdapter}，本文件独占
 * AI SDK 消息校验、tool-call 解析、流式镜像抑制和 finish reason 收窄。
 */

import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import {
  generateText,
  modelMessageSchema,
  streamText,
  type AssistantModelMessage,
  type LanguageModel,
  type ModelMessage,
} from 'ai';

import { isRecord } from '../../../../protocol/json-value.js';
import {
  createEmptyUsage,
  createToolCallMessage,
  mapAiSdkUsage,
  type AgentFinishReason,
  type AgentModel,
  type AgentModelEvent,
  type AgentModelRequest,
  type AgentModelResponse,
  type ModelAdapter,
} from '../../../agent/engine/index.js';

interface NormalizedAiSdkToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * 创建 Vercel AI SDK 模型 adapter。
 *
 * Args:
 * - 无：provider 连接已经包含在 `LanguageModel` 中；字符串模型引用只允许显式 provider 前缀。
 *
 * Returns:
 * - 返回无可变状态的 `ModelAdapter`；每次调用独占 AI SDK 请求与响应流。
 */
export function createAiSdkModelAdapter(): ModelAdapter {
  return {
    generate: generateWithAiSdk,
    stream: streamWithAiSdk,
  };
}

/**
 * 通过 AI SDK 完成一次非流式模型调用。
 *
 * Args:
 * - `request`: 已完成模型、消息、工具、provider options 和调用参数装配的请求。
 *
 * Returns:
 * - Promise 在响应消息完成运行时校验后兑现为 engine 模型响应。
 *
 * Throws:
 * - provider 失败、响应消息非法或模型引用格式错误时直接拒绝。
 */
async function generateWithAiSdk(
  request: AgentModelRequest,
): Promise<AgentModelResponse> {
  const result = await generateText({
    ...request.modelSettings,
    model: resolveLanguageModel(request.model),
    ...(request.system !== undefined ? { system: request.system } : {}),
    messages: request.messages,
    tools: request.tools,
    ...(request.activeTools !== undefined
      ? { activeTools: request.activeTools }
      : {}),
    ...(request.toolChoice !== undefined
      ? { toolChoice: request.toolChoice }
      : {}),
    ...(request.providerOptions !== undefined
      ? { providerOptions: request.providerOptions }
      : {}),
    ...(request.signal !== undefined ? { abortSignal: request.signal } : {}),
  });
  const newMessages = parseResponseMessages(result.responseMessages);
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
 * 通过 AI SDK 发起流式模型调用，并按 provider 到达顺序投影 engine 事件。
 *
 * Args:
 * - `request`: 已完成模型、消息、工具和取消信号装配的单次调用输入；函数只读取该对象。
 *
 * Returns:
 * - 返回单次调用拥有的异步事件流；迭代在收到最终响应并发布 `final` 后结束。
 *
 * Throws:
 * - provider 流失败、响应事件不满足协议或调用被取消时，迭代直接抛错。
 */
async function* streamWithAiSdk(
  request: AgentModelRequest,
): AsyncIterable<AgentModelEvent> {
  const result = streamText({
    ...request.modelSettings,
    model: resolveLanguageModel(request.model),
    ...(request.system !== undefined ? { system: request.system } : {}),
    messages: request.messages,
    tools: request.tools,
    ...(request.activeTools !== undefined
      ? { activeTools: request.activeTools }
      : {}),
    ...(request.toolChoice !== undefined
      ? { toolChoice: request.toolChoice }
      : {}),
    ...(request.providerOptions !== undefined
      ? { providerOptions: request.providerOptions }
      : {}),
    ...(request.signal !== undefined ? { abortSignal: request.signal } : {}),
  });
  let text = '';
  const pendingMirrorText: string[] = [];
  let bufferingPotentialMirror = true;
  let usage = createEmptyUsage();
  let finishReason: AgentFinishReason = 'unknown';
  const toolCalls: NormalizedAiSdkToolCall[] = [];
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
  const responseMessages = parseResponseMessages(await result.responseMessages);
  const newMessages =
    toolCalls.length > 0
      ? createStreamToolCallMessages(responseMessages, toolCalls)
      : responseMessages;
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

/**
 * 为流式 tool call 构造唯一 assistant 消息，并保留 provider reasoning parts。
 *
 * Args:
 * - `responseMessages`: 已通过 AI SDK message schema 校验的累计响应消息。
 * - `calls`: 从流事件逐个校验得到的 tool call，顺序与 provider 事件一致。
 *
 * Returns:
 * - 返回只包含一个 assistant 消息的数组，其中 reasoning 排列在 tool-call parts 前方。
 *
 * Throws:
 * - engine tool-call 消息工厂返回非 assistant 结构时直接抛错。
 */
function createStreamToolCallMessages(
  responseMessages: readonly ModelMessage[],
  calls: readonly NormalizedAiSdkToolCall[],
): ModelMessage[] {
  const reasoningParts = responseMessages.flatMap((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return [];
    }
    return message.content.filter((part) => part.type === 'reasoning');
  });
  const toolCallParts = calls.flatMap((call) => {
    const message = createToolCallMessage(call);
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      throw new Error('Tool call message factory returned an invalid message.');
    }
    return message.content.filter((part) => part.type === 'tool-call');
  });
  const message: AssistantModelMessage = {
    role: 'assistant',
    content: [...reasoningParts, ...toolCallParts],
  };
  return [message];
}

/**
 * 将 AI SDK 累计 response messages 标准化为 core 可保存的消息。
 *
 * 工具路径必须保留 assistant tool-call 和 tool-result 消息；否则下一轮模型
 * 看不到工具结果，会重复调用同一个工具直到 maxTurns。
 *
 * Args:
 * - `messages`: AI SDK 返回的外部消息数组，元素在进入 engine 前仍按 `unknown` 处理。
 *
 * Returns:
 * - 返回通过 `modelMessageSchema` 校验的消息数组。
 *
 * Throws:
 * - 响应为空或任一消息不满足 AI SDK message schema 时直接抛错。
 */
function parseResponseMessages(messages: readonly unknown[]): ModelMessage[] {
  if (messages.length === 0) {
    throw new Error('AI SDK response must contain at least one message.');
  }
  return modelMessageSchema.array().parse(messages);
}

/**
 * 校验并归一化一组 AI SDK tool call。
 *
 * Args:
 * - `value`: provider 返回的 tool call 数组；每个元素独立按外部值校验。
 *
 * Returns:
 * - 返回保持 provider 顺序的 `{ id, name, input }` 数组。
 *
 * Throws:
 * - 任一元素缺少协议字段时直接抛错。
 */
function normalizeToolCalls(
  value: readonly unknown[],
): NormalizedAiSdkToolCall[] {
  return value.map((item) => readToolCall(item));
}

/**
 * 将公开 model 配置解析为 AI SDK LanguageModel。
 *
 * Args:
 * - `model`: 显式 `provider:model` 字符串或已经构造好的 `LanguageModel`。
 *
 * Returns:
 * - 返回可直接交给 AI SDK generate/stream API 的 `LanguageModel`。
 *
 * Throws:
 * - 字符串缺少 provider 前缀、模型名为空或 provider 未声明时直接抛错。
 */
function resolveLanguageModel(model: AgentModel): LanguageModel {
  if (typeof model !== 'string') {
    return model;
  }
  const separator = model.indexOf(':');
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(
      `AI SDK model reference must use provider:model syntax: ${model}`,
    );
  }
  const provider = model.slice(0, separator);
  const modelName = model.slice(separator + 1);
  switch (provider) {
    case 'openai-chat':
      return openai.chat(modelName);
    case 'openai-responses':
    case 'openai':
      return openai.responses(modelName);
    case 'anthropic':
      return anthropic(modelName);
    default:
      throw new Error(`Unsupported AI SDK model provider: ${provider}`);
  }
}

/**
 * 解析单个 AI SDK tool-call part。
 *
 * Args:
 * - `value`: 从非流式结果或流事件读取的外部值。
 *
 * Returns:
 * - 返回经过字段存在性和非空校验的 engine tool-call 输入。
 *
 * Throws:
 * - 值不是对象、type 不匹配或缺少 `toolCallId`、`toolName`、`input` 时直接抛错。
 */
function readToolCall(value: unknown): NormalizedAiSdkToolCall {
  if (!isRecord(value)) {
    throw new Error('AI SDK tool-call part must be an object.');
  }
  const type = Reflect.get(value, 'type');
  const toolCallId = Reflect.get(value, 'toolCallId');
  const toolName = Reflect.get(value, 'toolName');
  if (type !== 'tool-call') {
    throw new Error('AI SDK tool-call part must have type "tool-call".');
  }
  if (typeof toolCallId !== 'string' || toolCallId === '') {
    throw new Error('AI SDK tool-call part is missing toolCallId.');
  }
  if (typeof toolName !== 'string' || toolName === '') {
    throw new Error('AI SDK tool-call part is missing toolName.');
  }
  if (!Object.hasOwn(value, 'input')) {
    throw new Error('AI SDK tool-call part is missing input.');
  }
  return {
    id: toolCallId,
    name: toolName,
    input: Reflect.get(value, 'input'),
  };
}

/**
 * 判断 provider 文本是否只是同一批 tool call 的 JSON 镜像。
 *
 * Args:
 * - `text`: 流式累计文本；解析失败代表普通文本。
 * - `toolCalls`: 已从结构化流事件读取的 tool call 顺序。
 *
 * Returns:
 * - 文本完整对应相同 ID/名称的 tool call 数组时返回 `true`。
 */
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
    if (!isToolCallPart(item)) {
      return false;
    }
    const expected = toolCalls[index];
    if (expected === undefined) {
      return false;
    }
    return (
      Reflect.get(item, 'toolCallId') === expected.id &&
      Reflect.get(item, 'toolName') === expected.name
    );
  });
}

/**
 * 判断尚未结束的文本前缀是否仍可能形成 tool-call JSON 镜像。
 *
 * Args:
 * - `text`: 当前累计流文本，允许是不完整 JSON 前缀。
 *
 * Returns:
 * - 前缀仍与 `{"type":"tool-call"...}` 或其数组形式兼容时返回 `true`。
 */
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

/**
 * 收窄已解析 JSON 中的 tool-call 对象。
 *
 * Args:
 * - `value`: JSON.parse 产生的未知元素。
 *
 * Returns:
 * - 值为对象且 `type` 严格等于 `tool-call` 时返回 `true`。
 */
function isToolCallPart(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Reflect.get(value, 'type') === 'tool-call';
}

/**
 * 把 provider finish reason 收窄到 engine 的闭合枚举。
 *
 * Args:
 * - `value`: AI SDK 或 provider 返回的外部结束原因。
 *
 * Returns:
 * - 返回已声明原因；第三方新增的未知值显式映射为 `unknown`。
 */
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
