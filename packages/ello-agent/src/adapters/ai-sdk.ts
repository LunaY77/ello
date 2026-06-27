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
      ...(request.activeTools !== undefined ? { activeTools: request.activeTools } : {}),
      ...(request.toolChoice !== undefined ? { toolChoice: request.toolChoice } : {}),
      ...(request.providerOptions !== undefined
        ? { providerOptions: request.providerOptions as never }
        : {}),
      ...(request.signal !== undefined ? { abortSignal: request.signal } : {}),
      ...(request.modelSettings as object),
    });
    return {
      text: result.text,
      messages: [...request.messages, { role: 'assistant', content: result.text }],
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
      ...(request.activeTools !== undefined ? { activeTools: request.activeTools } : {}),
      ...(request.toolChoice !== undefined ? { toolChoice: request.toolChoice } : {}),
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
    yield {
      type: 'final',
      response: {
        text,
        messages: [...request.messages, { role: 'assistant', content: text }],
        usage: coerceUsage(await result.usage),
        finishReason: normalizeFinishReason(await result.finishReason),
        provider: await result.response,
      },
    };
  }
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
  if (provider === 'openai' || provider === 'openai-chat') {
    return openai(modelName as Parameters<typeof openai>[0]);
  }
  if (provider === 'anthropic') {
    return anthropic(modelName as Parameters<typeof anthropic>[0]);
  }
  return openai(model as Parameters<typeof openai>[0]);
}

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
