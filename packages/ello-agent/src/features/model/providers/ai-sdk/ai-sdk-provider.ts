/**
 * 本文件把已校验的 provider/model descriptor 转换成 AI SDK `LanguageModel`。
 *
 * 模块不保存连接状态；provider 类型、endpoint 和 provider options 在这里穷举并校验，
 * 不支持的组合直接失败，不能把未知配置透传给第三方 SDK。
 */
import {
  createAnthropic,
  type AnthropicProviderSettings,
} from '@ai-sdk/anthropic';
import { createOpenAI, type OpenAIProviderSettings } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export type AiSdkLanguageModelEndpoint =
  | 'languageModel'
  | 'chat'
  | 'responses'
  | 'custom';

export type AiSdkProviderKind = 'openai' | 'anthropic' | 'openai-compatible';

export interface AiSdkLanguageModelDescriptor {
  /** provider 标识仅用于诊断和 AI SDK provider name，不参与产品层选择策略。 */
  readonly providerId: string;
  /** AI SDK provider 类型；包名和 factory 映射是框架内部实现细节。 */
  readonly providerKind: AiSdkProviderKind;
  /** provider 真实模型 ID，不等同于产品层 profile 名。 */
  readonly modelId: string;
  /** 调用端点；OpenAI-compatible chat/responses 的差异在这里表达。 */
  readonly endpoint: AiSdkLanguageModelEndpoint;
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly options?: Record<string, unknown>;
}

/**
 * 根据 AI SDK provider descriptor 创建 LanguageModel。
 *
 * 这是框架层和 AI SDK provider 包的边界：产品层可以维护 catalog、profile、
 * auth 和 capability。
 * 新 provider 类型只需要在这里扩展映射，`@ello/agent` 的调用循环仍只接收
 * 标准 `LanguageModel`。
 *
 * Args:
 * - `descriptor`: 已解析的 provider 连接、模型 ID 和 endpoint；函数只读取该对象。
 *
 * Returns:
 * - 返回绑定了 provider 配置的 AI SDK `LanguageModel`，调用生命周期由上层请求拥有。
 *
 * Throws:
 * - provider/model ID 为空、endpoint 与 provider 不匹配或 options 非法时直接抛错。
 */
export function createAiSdkLanguageModel(
  descriptor: AiSdkLanguageModelDescriptor,
): LanguageModel {
  assertDescriptor(descriptor);
  switch (descriptor.providerKind) {
    case 'anthropic': {
      if (descriptor.endpoint !== 'languageModel') {
        throw new Error(
          `Anthropic provider ${descriptor.providerId} requires endpoint languageModel; received ${descriptor.endpoint}.`,
        );
      }
      const anthropic = createAnthropic(anthropicProviderSettings(descriptor));
      return anthropic.languageModel(descriptor.modelId);
    }
    case 'openai':
    case 'openai-compatible': {
      const openai = createOpenAI(openAiProviderSettings(descriptor));
      switch (descriptor.endpoint) {
        case 'chat':
          return openai.chat(descriptor.modelId);
        case 'responses':
          return openai.responses(descriptor.modelId);
        case 'languageModel':
        case 'custom':
          return openai.languageModel(descriptor.modelId);
        default:
          descriptor.endpoint satisfies never;
          throw new Error(
            `Unsupported OpenAI endpoint: ${String(descriptor.endpoint)}`,
          );
      }
    }
    default:
      descriptor.providerKind satisfies never;
      throw new Error(
        `Unsupported AI SDK provider kind: ${String(descriptor.providerKind)}`,
      );
  }
}

/**
 * 校验创建 AI SDK provider 所需的稳定标识。
 *
 * Args:
 * - `descriptor`: 尚未交给第三方 factory 的 descriptor；函数不修改其中的连接配置。
 *
 * Returns:
 * - 标识满足非空约束时返回，不产生新值。
 *
 * Throws:
 * - provider ID 或 model ID 为空时直接抛错。
 */
function assertDescriptor(descriptor: AiSdkLanguageModelDescriptor): void {
  if (descriptor.providerId.trim() === '') {
    throw new Error('AI SDK providerId must be non-empty.');
  }
  if (descriptor.modelId.trim() === '') {
    throw new Error('AI SDK modelId must be non-empty.');
  }
}

/**
 * 构造 OpenAI provider factory 的精确 settings。
 *
 * Args:
 * - `descriptor`: OpenAI 或 OpenAI-compatible 连接描述；options 会在唯一边界校验。
 *
 * Returns:
 * - 返回只包含 AI SDK `OpenAIProviderSettings` 支持字段的对象。
 *
 * Throws:
 * - options 包含未知字段或字段值不是非空字符串时直接抛错。
 */
function openAiProviderSettings(
  descriptor: AiSdkLanguageModelDescriptor,
): OpenAIProviderSettings {
  const providerOptions = readOpenAiProviderOptions(descriptor.options);
  return {
    name: descriptor.providerId,
    ...(descriptor.baseURL === undefined
      ? {}
      : { baseURL: descriptor.baseURL }),
    ...(descriptor.apiKey === undefined ? {} : { apiKey: descriptor.apiKey }),
    ...(descriptor.headers === undefined
      ? {}
      : { headers: descriptor.headers }),
    ...providerOptions,
  };
}

/**
 * 构造 Anthropic provider factory 的精确 settings。
 *
 * Args:
 * - `descriptor`: Anthropic 连接描述；options 会在唯一边界校验。
 *
 * Returns:
 * - 返回只包含 AI SDK `AnthropicProviderSettings` 支持字段的对象。
 *
 * Throws:
 * - options 包含未知字段或 `authToken` 不是非空字符串时直接抛错。
 */
function anthropicProviderSettings(
  descriptor: AiSdkLanguageModelDescriptor,
): AnthropicProviderSettings {
  const providerOptions = readAnthropicProviderOptions(descriptor.options);
  return {
    name: descriptor.providerId,
    ...(descriptor.baseURL === undefined
      ? {}
      : { baseURL: descriptor.baseURL }),
    ...(descriptor.apiKey === undefined ? {} : { apiKey: descriptor.apiKey }),
    ...(descriptor.headers === undefined
      ? {}
      : { headers: descriptor.headers }),
    ...providerOptions,
  };
}

/**
 * 解析 OpenAI provider 的可选扩展字段。
 *
 * Args:
 * - `options`: 配置 schema 允许承载的未知字段映射；缺失表示没有扩展字段。
 *
 * Returns:
 * - 返回经过校验的 `organization` / `project` 子集。
 *
 * Throws:
 * - 出现其他字段或值不是非空字符串时直接抛错。
 */
function readOpenAiProviderOptions(
  options: Record<string, unknown> | undefined,
): Pick<OpenAIProviderSettings, 'organization' | 'project'> {
  const result: Pick<OpenAIProviderSettings, 'organization' | 'project'> = {};
  if (options === undefined) {
    return result;
  }
  for (const [key, value] of Object.entries(options)) {
    switch (key) {
      case 'organization':
      case 'project':
        result[key] = readNonEmptyString(value, `OpenAI provider ${key}`);
        break;
      default:
        throw new Error(`Unsupported OpenAI provider option: ${key}`);
    }
  }
  return result;
}

/**
 * 解析 Anthropic provider 的可选扩展字段。
 *
 * Args:
 * - `options`: 配置 schema 允许承载的未知字段映射；缺失表示没有扩展字段。
 *
 * Returns:
 * - 返回经过校验的 `authToken` 子集。
 *
 * Throws:
 * - 出现其他字段或值不是非空字符串时直接抛错。
 */
function readAnthropicProviderOptions(
  options: Record<string, unknown> | undefined,
): Pick<AnthropicProviderSettings, 'authToken'> {
  const result: Pick<AnthropicProviderSettings, 'authToken'> = {};
  if (options === undefined) {
    return result;
  }
  for (const [key, value] of Object.entries(options)) {
    if (key !== 'authToken') {
      throw new Error(`Unsupported Anthropic provider option: ${key}`);
    }
    result.authToken = readNonEmptyString(value, 'Anthropic authToken');
  }
  return result;
}

/**
 * 把 provider option 的未知值收窄为非空字符串。
 *
 * Args:
 * - `value`: 从配置 options 读取的外部值。
 * - `name`: 用于错误定位的字段名称。
 *
 * Returns:
 * - 返回原始非空字符串，不做隐式 trim 或替换。
 *
 * Throws:
 * - 值不是字符串或仅包含空白时直接抛错。
 */
function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}
