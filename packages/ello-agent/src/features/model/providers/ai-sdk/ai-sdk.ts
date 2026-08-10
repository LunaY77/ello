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
  wrapLanguageModel,
  type AssistantModelMessage,
  type LanguageModel,
  type LanguageModelMiddleware,
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
  type ConversationMessage,
  type ModelAdapter,
} from '../../../agent/engine/index.js';

interface NormalizedAiSdkToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

type WrappableLanguageModel = Parameters<typeof wrapLanguageModel>[0]['model'];

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
  assertConversationMessages(request.messages);
  const result = await generateText({
    ...request.modelSettings,
    model: resolveLanguageModel(request.model),
    ...(request.instructions === undefined
      ? {}
      : { instructions: request.instructions }),
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
  assertConversationMessages(request.messages);
  const result = streamText({
    ...request.modelSettings,
    model: modelWithReasoningLifecycleRecovery(request.model),
    ...(request.instructions === undefined
      ? {}
      : { instructions: request.instructions }),
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
  let announcedStreamStart = false;
  for await (const part of result.fullStream) {
    // 首个承载内容的 part 决定 time-to-first-token，无论它是正文、推理还是
    // 工具调用；只在正文上计时会让纯工具轮和推理优先的轮次完全没有该指标。
    if (!announcedStreamStart && carriesContent(part.type)) {
      announcedStreamStart = true;
      yield { type: 'stream-start' };
    }
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
    } else if (part.type === 'reasoning-delta') {
      yield { type: 'reasoning-delta', text: part.text };
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

function assertConversationMessages(
  messages: readonly { readonly role: string }[],
): void {
  for (const message of messages) {
    if (message.role === 'system') {
      throw new Error('AI SDK messages must not contain a system role.');
    }
  }
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
): ConversationMessage[] {
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
 * 看不到工具结果，会重复调用同一个工具并阻止 run 自然完成。
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
function parseResponseMessages(
  messages: readonly unknown[],
): ConversationMessage[] {
  if (messages.length === 0) {
    throw new Error('AI SDK response must contain at least one message.');
  }
  const parsed = modelMessageSchema.array().parse(messages);
  assertConversationMessages(parsed);
  return parsed.filter(
    (message): message is ConversationMessage => message.role !== 'system',
  );
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
function resolveLanguageModel(model: AgentModel): WrappableLanguageModel {
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
 * 在 AI SDK 聚合响应前补齐缺失的 reasoning 生命周期起点。
 *
 * 部分 Responses 兼容代理会省略或错序 `reasoning-start`，却继续发送相同 ID 的
 * delta/end。AI SDK 的上层聚合器会把这种流转换为 `reasoning part ... not found`
 * 错误并丢弃整轮响应。这里仅补齐缺失的 start；完整、有序的 provider 流逐项透传。
 *
 * Args:
 * - `model`: engine 配置中的模型引用或已构造的 AI SDK 模型。
 *
 * Returns:
 * - 返回带 reasoning 生命周期恢复中间件的 V4 模型。
 */
function modelWithReasoningLifecycleRecovery(model: AgentModel): LanguageModel {
  return wrapLanguageModel({
    model: resolveLanguageModel(model),
    middleware: reasoningLifecycleRecoveryMiddleware,
  });
}

const reasoningLifecycleRecoveryMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  wrapStream: async ({ doStream }) => {
    const result = await doStream();
    const activeReasoningIds = new Set<string>();
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'reasoning-start') {
              if (activeReasoningIds.has(part.id)) {
                return;
              }
              activeReasoningIds.add(part.id);
              controller.enqueue(part);
              return;
            }
            if (
              (part.type === 'reasoning-delta' ||
                part.type === 'reasoning-end') &&
              !activeReasoningIds.has(part.id)
            ) {
              activeReasoningIds.add(part.id);
              controller.enqueue({
                type: 'reasoning-start',
                id: part.id,
                ...(part.providerMetadata === undefined
                  ? {}
                  : { providerMetadata: part.providerMetadata }),
              });
            }
            controller.enqueue(part);
            if (part.type === 'reasoning-end') {
              activeReasoningIds.delete(part.id);
            }
          },
        }),
      ),
    };
  },
};

/**
 * 解析单个 AI SDK tool-call part。
 *
 * Args:
 * - `value`: 从非流式结果或流事件读取的外部值。
 *
 * Returns:
 * - 返回经过字段存在性和 provider-safe 输入校验的 engine tool-call 输入。
 *
 * Throws:
 * - 值不是对象、type 不匹配或缺少 `toolCallId`、`toolName`、`input` 时直接抛错；
 *   非对象 input 会归一化为 `{}`，避免无效 provider 参数污染后续 Anthropic history。
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
    input: providerSafeToolInput(Reflect.get(value, 'input')),
  };
}

/**
 * 确保写回模型 history 的 tool-call input 始终是 provider 接受的对象。
 *
 * AI SDK 会把 schema 校验失败的双重编码参数保留为字符串，并同时标记
 * `invalid: true`。Ello 随后仍需把这次调用交给 command runtime，让它生成
 * 可恢复的输入错误；但 Anthropic `tool_use.input` 不能是字符串，因此只在
 * 这个最外层边界把非对象值替换为空对象。对象内部的 schema 错误保持原样，
 * 由 command runtime 负责返回具体错误。
 */
function providerSafeToolInput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
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
 * 承载模型输出内容的 stream part 类型。
 *
 * 只列举首个到达即说明模型已开始产出的类型：正文、推理、工具调用及其入参。
 * `start` / `start-step` / `model-call-start` 等生命周期 part 在模型产出前
 * 就会到达，用它们计时会把请求开销算进 first-token 延迟。
 */
const CONTENT_PART_TYPES: ReadonlySet<string> = new Set([
  'text-delta',
  'text-start',
  'reasoning-delta',
  'reasoning-start',
  'tool-call',
  'tool-input-start',
  'tool-input-delta',
  'dynamic-tool',
]);

/**
 * 判断某个 stream part 是否承载模型输出内容。
 *
 * Args:
 * - `type`: AI SDK stream part 的 `type` 字段。
 *
 * Returns:
 * - part 承载正文、推理或工具调用内容时返回 `true`，生命周期 part 返回 `false`。
 */
function carriesContent(type: string): boolean {
  return CONTENT_PART_TYPES.has(type);
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
