/**
 * Vercel AI SDK 模型适配器。
 *
 * 把框架的标准 {@link AgentModelRequest} 翻译成 AI SDK 的 `generateText` /
 * `streamText` 调用，并把其响应（文本、消息、tool call、用量、结束原因）反向
 * 归一化回框架的标准响应形态。这是框架默认依赖具体 provider 的唯一位置——核心
 * 循环只面向 {@link ModelAdapter} 接口编程，替换此适配器即可接入测试桩或私有模型服务。
 */

import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import {
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from 'ai';

import { coerceUsage } from '../core/usage.js';
import type {
  AgentFinishReason,
  AgentModel,
  AgentModelEvent,
  AgentModelRequest,
  AgentModelResponse,
  ModelAdapter,
} from '../public/types.js';

/**
 * 默认 Vercel AI SDK adapter。
 *
 * 该 adapter 是 @ello/agent 与 Vercel AI SDK 的唯一默认耦合点。核心 loop
 * 面向 ModelAdapter 编程，因此测试或私有模型服务可以替换这里。
 */
export class AiSdkModelAdapter implements ModelAdapter {
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
      model: resolveLanguageModel(request.model),
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
    return {
      text: result.text,
      messages: [...request.messages, ...newMessages],
      newMessages,
      toolCalls: normalizeToolCalls(result.toolCalls),
      toolResults: result.toolResults,
      usage: coerceUsage(result.usage),
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
      model: resolveLanguageModel(request.model),
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
    for await (const delta of result.textStream) {
      yield { type: 'text-delta', text: delta };
    }
    const text = await result.text;
    const responseMessages = await result.responseMessages;
    const newMessages = normalizeResponseMessages(responseMessages, text);
    yield {
      type: 'final',
      response: {
        text,
        messages: [...request.messages, ...newMessages],
        newMessages,
        toolCalls: normalizeToolCalls(await result.toolCalls),
        toolResults: await result.toolResults,
        usage: coerceUsage(await result.usage),
        finishReason: normalizeFinishReason(await result.finishReason),
        provider: await result.response,
      },
    };
  }
}

/**
 * 将 AI SDK 累计 response messages 标准化为 core 可保存的消息。
 *
 * 工具路径必须保留 assistant tool-call 和 tool-result 消息；否则下一轮模型
 * 看不到工具结果，会重复调用同一个工具直到 maxTurns。
 */
function normalizeResponseMessages(
  messages: readonly unknown[],
  fallbackText: string,
): ModelMessage[] {
  if (messages.length > 0) {
    return messages as ModelMessage[];
  }
  return fallbackText ? [{ role: 'assistant', content: fallbackText }] : [];
}

/**
 * 把 AI SDK 形态各异的 tool call 归一化为框架标准 `{ id, name, input }`。
 *
 * 兼容不同字段命名（`toolCallId`/`id`、`toolName`/`name`、`input`/`args`），
 * 缺失 id 时回退为按序号生成的占位标识，缺失名时回退 `'unknown'`。
 */
function normalizeToolCalls(value: readonly unknown[]) {
  return value.map((item, index) => {
    const record = item as Record<string, unknown>;
    return {
      id: String(record.toolCallId ?? record.id ?? `tool_${index}`),
      name: String(record.toolName ?? record.name ?? 'unknown'),
      input: record.input ?? record.args ?? {},
    };
  });
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
export function resolveLanguageModel(model: AgentModel): LanguageModel {
  if (typeof model !== 'string') {
    return model;
  }
  const [provider, ...rest] = model.split(':');
  const modelName = rest.join(':') || provider || model;
  if (provider === 'openai-chat') {
    return openai.chat(modelName as Parameters<typeof openai.chat>[0]);
  }
  if (provider === 'openai-responses' || provider === 'openai') {
    return openai.responses(
      modelName as Parameters<typeof openai.responses>[0],
    );
  }
  if (provider === 'anthropic') {
    return anthropic(modelName as Parameters<typeof anthropic>[0]);
  }
  return openai(model as Parameters<typeof openai>[0]);
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
