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

export type AnthropicAuthScheme = 'api-key' | 'bearer';

export type AiSdkLanguageModelEndpoint = 'chat' | 'responses';

export type AiSdkProtocol = 'openai' | 'anthropic' | 'openai-compatible';

export interface AiSdkLanguageModelDescriptor {
  readonly protocol: AiSdkProtocol;
  readonly modelId: string;
  readonly endpoint?: AiSdkLanguageModelEndpoint;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly authScheme?: AnthropicAuthScheme;
}

/**
 * 根据 AI SDK provider descriptor 创建 LanguageModel。
 *
 * 这是框架层和 AI SDK provider 包的边界：产品层可以维护命名模型目录、
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
  switch (descriptor.protocol) {
    case 'anthropic': {
      if (descriptor.endpoint !== undefined) {
        throw new Error(
          `Anthropic protocol forbids endpoint; received ${descriptor.endpoint}.`,
        );
      }
      if (descriptor.authScheme === undefined) {
        throw new Error('Anthropic protocol requires an explicit authScheme.');
      }
      const anthropic = createAnthropic(
        createAnthropicProviderSettings(descriptor),
      );
      return anthropic.languageModel(descriptor.modelId);
    }
    case 'openai':
    case 'openai-compatible': {
      const openai = createOpenAI(createOpenAiProviderSettings(descriptor));
      switch (descriptor.endpoint) {
        case 'chat':
          return openai.chat(descriptor.modelId);
        case 'responses':
          return openai.responses(descriptor.modelId);
        case undefined:
          throw new Error(
            `${descriptor.protocol} protocol requires an explicit endpoint.`,
          );
        default:
          descriptor.endpoint satisfies never;
          throw new Error(
            `Unsupported OpenAI endpoint: ${String(descriptor.endpoint)}`,
          );
      }
    }
    default:
      descriptor.protocol satisfies never;
      throw new Error(
        `Unsupported AI SDK protocol: ${String(descriptor.protocol)}`,
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
  if (descriptor.modelId.trim() === '') {
    throw new Error('AI SDK modelId must be non-empty.');
  }
  if (descriptor.headers === undefined) return;
  const reservedHeader =
    descriptor.protocol === 'anthropic' && descriptor.authScheme === 'api-key'
      ? 'x-api-key'
      : 'authorization';
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(descriptor.headers)) {
    const normalizedName = name.toLowerCase();
    if (name.trim() === '' || /[^!#$%&'*+.^_`|~0-9A-Za-z-]/u.test(name)) {
      throw new Error(`Invalid HTTP header name: ${name}`);
    }
    if (value.length === 0 || /[\r\n]/u.test(value)) {
      throw new Error(`Invalid HTTP header value for ${name}.`);
    }
    if (seen.has(normalizedName)) {
      throw new Error(`Duplicate HTTP header name: ${name}`);
    }
    if (normalizedName === reservedHeader) {
      throw new Error(
        `Custom HTTP headers must not override provider authentication header ${reservedHeader}.`,
      );
    }
    seen.add(normalizedName);
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
export function createOpenAiProviderSettings(
  descriptor: AiSdkLanguageModelDescriptor,
): OpenAIProviderSettings {
  return {
    name: descriptor.protocol,
    baseURL: descriptor.baseURL,
    apiKey: descriptor.apiKey,
    ...(descriptor.headers === undefined
      ? {}
      : { headers: descriptor.headers }),
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
export function createAnthropicProviderSettings(
  descriptor: AiSdkLanguageModelDescriptor,
): AnthropicProviderSettings {
  switch (descriptor.authScheme) {
    case 'api-key':
      return {
        name: descriptor.protocol,
        baseURL: descriptor.baseURL,
        apiKey: descriptor.apiKey,
        ...(descriptor.headers === undefined
          ? {}
          : { headers: descriptor.headers }),
      };
    case 'bearer':
      return {
        name: descriptor.protocol,
        baseURL: descriptor.baseURL,
        authToken: descriptor.apiKey,
        ...(descriptor.headers === undefined
          ? {}
          : { headers: descriptor.headers }),
      };
    case undefined:
      throw new Error('Anthropic protocol requires an explicit authScheme.');
    default:
      descriptor.authScheme satisfies never;
      throw new Error(
        `Unsupported Anthropic auth scheme: ${String(descriptor.authScheme)}`,
      );
  }
}
