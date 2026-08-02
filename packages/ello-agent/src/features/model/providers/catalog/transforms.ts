/**
 * 本文件负责把已解析的 runtime model 转换为 engine 调用预算、模型参数和 provider cache 输入。
 * 所有窗口限制都在这里收敛为单一预算，调用方不得重新从原始 config 推导更宽的值。
 */
import { createHash } from 'node:crypto';

import type {
  AgentModelSettings,
  AgentProviderOptions,
  CreateAgentOptions,
  ModelInput,
} from '../../../agent/engine/index.js';
import {
  joinSystemCacheSegments,
  splitSystemCacheSegments,
} from '../../../agent/engine/index.js';
import type { ContextConfig } from '../../../config/index.js';

import type { RuntimeModel } from './types.js';

/**
 * 生成产品 Agent 与 internal Agent 共用的唯一模型输入预算。
 *
 * Args:
 * - `model`: 已解析的 runtime model，包含模型声明的 context window。
 * - `context`: 已校验的 context 配置，只能缩小模型窗口，不能放大。
 *
 * Returns:
 * - 返回 engine 使用的输入上限与输出预留量。
 *
 * Throws:
 * - 模型的最大输出占满 context window、没有剩余输入容量时抛出配置错误。
 */
export function modelInputBudgetFromRuntimeModel(
  model: RuntimeModel,
  context: ContextConfig,
): NonNullable<CreateAgentOptions['modelInputBudget']> {
  const configuredInputTokens =
    context.max_input_tokens - context.reserved_output_tokens;
  const modelInputTokens = model.contextWindow - model.maxOutputTokens;
  if (modelInputTokens < 1) {
    throw new Error(
      `max_output_tokens (${model.maxOutputTokens}) leaves no input capacity within context_window (${model.contextWindow}) for model '${model.name}'.`,
    );
  }
  const availableInputTokens = Math.min(
    configuredInputTokens,
    modelInputTokens,
  );
  return {
    maxInputTokens: availableInputTokens + context.reserved_output_tokens,
    reservedOutputTokens: context.reserved_output_tokens,
  };
}

/**
 * 把 runtime model 的输出与 reasoning 配置转换为 engine model settings。
 *
 * Args:
 * - `model`: 已解析并固定协议的 runtime model。
 *
 * Returns:
 * - 返回可直接传给 model adapter 的稳定设置。
 */
export function modelSettingsFromRuntimeModel(
  model: RuntimeModel,
): AgentModelSettings {
  return {
    maxOutputTokens: model.maxOutputTokens,
    reasoning:
      model.reasoningEffort === 'max' ? 'xhigh' : model.reasoningEffort,
  };
}

/**
 * 把 runtime model 的协议专用状态与思考强度转换为 provider options。
 *
 * Args:
 * - `model`: 已解析并固定协议的 runtime model。
 *
 * Returns:
 * - OpenAI Responses 模型关闭服务端状态，避免兼容代理跨请求引用失效的 item ID。
 * - DeepSeek Anthropic 兼容模型返回原生 thinking 与 effort；其他模型返回 `undefined`。
 */
export function providerOptionsFromRuntimeModel(
  model: RuntimeModel,
): AgentProviderOptions | undefined {
  if (model.protocol === 'openai' && model.endpoint === 'responses') {
    return { openai: { store: false } };
  }
  if (model.protocol === 'anthropic' && isDeepSeekModel(model)) {
    return {
      anthropic: {
        thinking: { type: 'adaptive' },
        effort: model.reasoningEffort,
      },
    };
  }
  return undefined;
}

function isDeepSeekModel(model: RuntimeModel): boolean {
  return [model.name, model.apiModel, model.baseUrl].some((value) =>
    value.toLowerCase().includes('deepseek'),
  );
}

/**
 * 按模型协议整理最终输入并添加 provider cache 元数据。
 *
 * Args:
 * - `model`: 决定 cache 策略和协议分支的 runtime model。
 * - `input`: engine 已完成预算处理的最终模型输入。
 * - `cache`: 构造稳定 cache identity 所需的 prompt profile 与 cwd。
 *
 * Returns:
 * - 返回 provider 可接受且保留 diagnostics 的新模型输入。
 *
 * Throws:
 * - 指令结构或协议不满足对应 provider 约束时抛错。
 */
export function prepareModelInputForRuntimeModel(
  model: RuntimeModel,
  input: ModelInput,
  cache: { readonly promptProfile: string; readonly cwdIdentity: string },
): ModelInput {
  if (input.instructions === undefined) {
    return input;
  }
  if (typeof input.instructions !== 'string') {
    throw new Error(
      'Engine instructions must be a string before model transforms.',
    );
  }
  const segments = splitSystemCacheSegments(input.instructions);
  const normalized = {
    ...input,
    instructions: joinSystemCacheSegments(segments),
  } satisfies ModelInput;
  switch (model.protocol) {
    case 'anthropic':
      return addAnthropicCacheBreakpoints(normalized, segments);
    case 'openai':
      return addOpenAiPromptCacheKey(model, normalized, cache, segments);
    case 'openai-compatible':
      return normalized;
    default:
      model.protocol satisfies never;
      throw new Error(`Unsupported model protocol: ${String(model.protocol)}`);
  }
}

function addOpenAiPromptCacheKey(
  model: RuntimeModel,
  input: ModelInput,
  cache: { readonly promptProfile: string; readonly cwdIdentity: string },
  segments: { readonly stable: string; readonly dynamic: string },
): ModelInput {
  if (input.diagnostics === undefined) {
    throw new Error('Model input diagnostics are required for prompt caching.');
  }
  const existingProviderOptions = input.providerOptions;
  const openai =
    existingProviderOptions === undefined
      ? undefined
      : existingProviderOptions.openai;
  const promptCacheKey = hash(
    [
      model.name,
      cache.promptProfile,
      cache.cwdIdentity,
      input.diagnostics.toolsetFingerprint,
      hash(segments.stable),
    ].join('\n'),
  );
  return {
    ...input,
    providerOptions: {
      ...(existingProviderOptions === undefined ? {} : existingProviderOptions),
      openai: { ...(openai === undefined ? {} : openai), promptCacheKey },
    },
  };
}

function addAnthropicCacheBreakpoints(
  input: ModelInput,
  segments: { readonly stable: string; readonly dynamic: string },
): ModelInput {
  if (segments.stable === '') {
    throw new Error(
      'Anthropic cache breakpoint requires non-empty instructions.',
    );
  }
  if (input.messages.length === 0) {
    throw new Error(
      'Anthropic cache breakpoint requires conversation messages.',
    );
  }
  return {
    ...input,
    instructions: [
      {
        role: 'system',
        content: segments.stable,
        providerOptions: {
          anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
        },
      },
      ...(segments.dynamic === ''
        ? []
        : [{ role: 'system' as const, content: segments.dynamic }]),
    ],
    messages: addConversationCacheBreakpoints(input.messages),
  };
}

/**
 * 对话断点分层布局。Anthropic 每请求最多 4 个断点，system stable 占 1 个
 * （tools 在请求里排在 system 之前，被同一前缀覆盖，不需要独立断点），
 * 余下 3 个全部落在 messages 上：尾部断点每轮前移，锚点断点每
 * `CONVERSATION_ANCHOR_STRIDE` 轮才前移一次。
 *
 * 锚点必须在两次前移之间逐字节不动，否则退化成与尾部断点同样的每轮失效。
 * 尾部断点失效（TTL 过期、驱逐、路由未命中）时，锚点仍能命中绝大部分前缀，
 * 而不是跌回只剩 system 的量级。
 */
const CONVERSATION_ANCHOR_STRIDE = 20;
const CONVERSATION_ANCHOR_COUNT = 2;

type CacheTtl = '1h' | '5m';

function addConversationCacheBreakpoints(
  messages: ModelInput['messages'],
): ModelInput['messages'] {
  const breakpoints = conversationCacheBreakpoints(messages.length);
  return messages.map((message, index) => {
    const ttl = breakpoints.get(index);
    return ttl === undefined
      ? message
      : addAnthropicConversationCacheBreakpoint(message, ttl);
  });
}

function conversationCacheBreakpoints(
  messageCount: number,
): Map<number, CacheTtl> {
  const tail = messageCount - 1;
  const breakpoints = new Map<number, CacheTtl>();
  for (
    let ordinal = Math.floor(tail / CONVERSATION_ANCHOR_STRIDE);
    ordinal >= 1 && breakpoints.size < CONVERSATION_ANCHOR_COUNT;
    ordinal -= 1
  ) {
    const index = ordinal * CONVERSATION_ANCHOR_STRIDE - 1;
    if (index < tail) {
      breakpoints.set(index, '1h');
    }
  }
  breakpoints.set(tail, '5m');
  return breakpoints;
}

function addAnthropicConversationCacheBreakpoint(
  message: ModelInput['messages'][number],
  ttl: CacheTtl,
): ModelInput['messages'][number] {
  const existingProviderOptions = message.providerOptions;
  const existingAnthropic =
    existingProviderOptions === undefined
      ? undefined
      : existingProviderOptions.anthropic;
  return {
    ...message,
    providerOptions: {
      ...(existingProviderOptions === undefined ? {} : existingProviderOptions),
      anthropic: {
        ...(existingAnthropic === undefined ? {} : existingAnthropic),
        cacheControl: { type: 'ephemeral', ttl },
      },
    } as AgentProviderOptions,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
