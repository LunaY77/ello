import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI, openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

/** 模型行为包装器类型。 */
export type ModelWrapper = (
  model: LanguageModel,
  agentName: string,
  context: Record<string, unknown>,
) => LanguageModel;

/** 默认模型名。 */
export const DEFAULT_MODEL_NAME = 'openai-chat:gpt-4o-mini';

const AMBIGUOUS_OPENAI_PROVIDER_ERROR =
  "Model provider 'openai:' is ambiguous. Use 'openai-chat:<model>' for Chat Completions or 'openai-responses:<model>' for the Responses API.";
const BASE_URL_UNSUPPORTED_PROVIDER_ERROR =
  'base_url is not supported for this model provider. Use openai-chat, openai-responses, or anthropic.';
const GATEWAY_PREFIX = 'gateway@';

/**
 * 描述运行时实际使用的模型配置。
 */
export interface ModelSelection {
  modelName: string;
  baseUrl: string | null;
  model: LanguageModel;
}

/**
 * 规范化调用方传入的 model string。
 */
export function normalizeModelName(modelName?: string | null): string {
  const selected =
    (modelName ?? DEFAULT_MODEL_NAME).trim() || DEFAULT_MODEL_NAME;
  if (selected.startsWith('openai:')) {
    throw new Error(AMBIGUOUS_OPENAI_PROVIDER_ERROR);
  }
  return selected;
}

/**
 * 从 model string 中分离 provider 和 model name。
 */
export function splitProviderAndModel(
  modelString: string,
): [string | null, string] {
  const index = modelString.indexOf(':');
  if (index === -1) {
    return [null, modelString];
  }
  return [modelString.slice(0, index), modelString.slice(index + 1)];
}

/**
 * 读取 gateway 的 API key 和 base URL 环境变量。
 */
function readGatewayCredentials(gatewayName: string): {
  apiKey: string;
  baseUrl: string;
} {
  const prefix = gatewayName.toUpperCase();
  const apiKeyVar = `${prefix}_API_KEY`;
  const baseUrlVar = `${prefix}_BASE_URL`;
  const apiKey = process.env[apiKeyVar];
  const baseUrl = process.env[baseUrlVar];

  if (!apiKey) {
    throw new Error(
      `Gateway API key not found: set ${apiKeyVar} environment variable.`,
    );
  }
  if (!baseUrl) {
    throw new Error(
      `Gateway base URL not found: set ${baseUrlVar} environment variable.`,
    );
  }

  return { apiKey, baseUrl };
}

/**
 * 解析 Anthropic provider 可用的 base URL。
 */
function resolveAnthropicBaseUrl(
  modelName: string,
  baseUrl?: string | null,
): string | null {
  const [provider] = splitProviderAndModel(modelName);
  if (provider !== 'anthropic') {
    return baseUrl?.trim() || null;
  }

  const resolved =
    baseUrl?.trim() || process.env.ANTHROPIC_BASE_URL?.trim() || null;
  if (resolved === null) {
    return null;
  }
  return resolved.endsWith('/v1') ? resolved.slice(0, -3) : resolved;
}

/**
 * 使用 Vercel AI SDK 创建模型实例。
 *
 * Args:
 *   providerName: provider 名称, 如 openai-chat 或 anthropic。
 *   modelId: provider 内部模型名。
 *   baseUrl: 可选的 provider base URL。
 *   apiKey: 可选的 API key, gateway 模式会显式传入。
 *
 * Returns:
 *   Vercel AI SDK LanguageModel。
 */
function createLanguageModel(
  providerName: string | null,
  modelId: string,
  options: { baseUrl?: string | null; apiKey?: string | null } = {},
): LanguageModel {
  if (providerName === null || providerName === 'openai-chat') {
    if (options.baseUrl || options.apiKey) {
      return createOpenAI(providerOptions(options)).chat(modelId);
    }
    return openai.chat(modelId);
  }

  if (providerName === 'openai-responses') {
    if (options.baseUrl || options.apiKey) {
      return createOpenAI(providerOptions(options)).responses(modelId);
    }
    return openai.responses(modelId);
  }

  if (providerName === 'openai') {
    throw new Error(AMBIGUOUS_OPENAI_PROVIDER_ERROR);
  }

  if (providerName === 'anthropic') {
    if (options.baseUrl || options.apiKey) {
      return createAnthropic(providerOptions(options))(modelId);
    }
    return anthropic(modelId);
  }

  throw new Error(`Unsupported model provider: ${providerName}`);
}

/**
 * 校验直接传入 baseUrl 时的 provider 范围。
 */
function assertBaseUrlSupported(
  providerName: string | null,
  baseUrl?: string | null,
): void {
  if (!baseUrl?.trim()) {
    return;
  }
  if (
    providerName === null ||
    providerName === 'openai-chat' ||
    providerName === 'openai-responses' ||
    providerName === 'anthropic'
  ) {
    return;
  }
  throw new Error(BASE_URL_UNSUPPORTED_PROVIDER_ERROR);
}

/**
 * 构造 provider options, 避免在 exactOptionalPropertyTypes 下传入 undefined。
 */
function providerOptions(options: {
  baseUrl?: string | null;
  apiKey?: string | null;
}): {
  baseURL?: string;
  apiKey?: string;
} {
  return {
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  };
}

/**
 * 把 model string 解析成 Vercel AI SDK LanguageModel。
 *
 * 支持三种模式:
 * 1. 标准 model string: openai-chat:gpt-4o-mini
 * 2. Gateway 前缀: gateway@mygateway:openai-chat:gpt-4o-mini
 * 3. 带 baseUrl 的直接覆盖
 */
export function resolveModel(
  options: {
    modelName?: string | null;
    baseUrl?: string | null;
  } = {},
): ModelSelection {
  const rawName =
    (options.modelName ?? DEFAULT_MODEL_NAME).trim() || DEFAULT_MODEL_NAME;

  if (rawName.startsWith(GATEWAY_PREFIX)) {
    const rest = rawName.slice(GATEWAY_PREFIX.length);
    const index = rest.indexOf(':');
    if (index === -1) {
      throw new Error(
        `Invalid gateway model string: '${rawName}'. Expected format: gateway@<name>:<provider>:<model>`,
      );
    }
    const gatewayName = rest.slice(0, index);
    if (!gatewayName) {
      throw new Error('Gateway name cannot be empty.');
    }
    const providerModel = rest.slice(index + 1);
    const normalized = normalizeModelName(providerModel);
    const [providerName, modelId] = splitProviderAndModel(normalized);
    const credentials = readGatewayCredentials(gatewayName);
    return {
      modelName: normalized,
      baseUrl: credentials.baseUrl,
      model: createLanguageModel(providerName, modelId, credentials),
    };
  }

  const normalized = normalizeModelName(rawName);
  const [providerName, modelId] = splitProviderAndModel(normalized);
  assertBaseUrlSupported(providerName, options.baseUrl);
  const effectiveBaseUrl = resolveAnthropicBaseUrl(normalized, options.baseUrl);
  return {
    modelName: normalized,
    baseUrl: effectiveBaseUrl,
    model: createLanguageModel(providerName, modelId, {
      baseUrl: effectiveBaseUrl,
    }),
  };
}
