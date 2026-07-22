/**
 * 本文件负责 config feature 的“provider-catalog”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type {
  CodingAgentConfig,
  ModelCatalogEntryConfig,
  ProfileSuiteConfig,
  ProviderConnectionConfig,
} from './schema.js';

export interface ProviderCatalog {
  readonly provider: Record<string, ProviderConnectionConfig>;
  readonly models: Record<string, Record<string, ModelCatalogEntryConfig>>;
  readonly profile: Record<string, ProfileSuiteConfig>;
}

const zeroCost = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
};

export const builtinProviderCatalog: ProviderCatalog = {
  provider: {
    openai: {
      name: 'OpenAI',
      enabled: true,
      kind: 'openai',
      api_key_env: 'OPENAI_API_KEY',
      base_url: 'https://api.openai.com/v1',
      headers: {},
      options: {},
    },
    anthropic: {
      name: 'Anthropic',
      enabled: true,
      kind: 'anthropic',
      api_key_env: 'ANTHROPIC_API_KEY',
      headers: {},
      options: {},
    },
  },
  models: {
    openai: {
      'gpt-5.5': {
        provider: 'openai',
        api_id: 'gpt-5.5',
        endpoint: 'responses',
        status: 'active',
        context: 400_000,
        output: 32_000,
        cost: zeroCost,
        reasoning: true,
        temperature: false,
        tool_call: true,
        input_modalities: ['text', 'image', 'pdf'],
        output_modalities: ['text'],
        headers: {},
        options: {},
        variants: {
          none: { reasoningEffort: 'none' },
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
          xhigh: { reasoningEffort: 'xhigh' },
        },
      },
      'gpt-5.4': {
        provider: 'openai',
        api_id: 'gpt-5.4',
        endpoint: 'responses',
        status: 'active',
        context: 400_000,
        output: 32_000,
        cost: zeroCost,
        reasoning: true,
        temperature: false,
        tool_call: true,
        input_modalities: ['text', 'image', 'pdf'],
        output_modalities: ['text'],
        headers: {},
        options: {},
        variants: {
          none: { reasoningEffort: 'none' },
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
        },
      },
    },
    anthropic: {
      'claude-opus-4.8': {
        provider: 'anthropic',
        api_id: 'claude-opus-4.8',
        status: 'active',
        context: 200_000,
        output: 64_000,
        cost: zeroCost,
        reasoning: true,
        temperature: true,
        tool_call: true,
        input_modalities: ['text', 'image', 'pdf'],
        output_modalities: ['text'],
        headers: {},
        options: {},
        variants: {
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
        },
      },
      'claude-opus-4.7': {
        provider: 'anthropic',
        api_id: 'claude-opus-4.7',
        status: 'active',
        context: 200_000,
        output: 64_000,
        cost: zeroCost,
        reasoning: true,
        temperature: true,
        tool_call: true,
        input_modalities: ['text', 'image', 'pdf'],
        output_modalities: ['text'],
        headers: {},
        options: {},
        variants: {
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
        },
      },
      'claude-opus-4.6': {
        provider: 'anthropic',
        api_id: 'claude-opus-4.6',
        status: 'active',
        context: 200_000,
        output: 64_000,
        cost: zeroCost,
        reasoning: true,
        temperature: true,
        tool_call: true,
        input_modalities: ['text', 'image', 'pdf'],
        output_modalities: ['text'],
        headers: {},
        options: {},
        variants: {
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
        },
      },
      'claude-sonnet-4.6': {
        provider: 'anthropic',
        api_id: 'claude-sonnet-4.6',
        status: 'active',
        context: 200_000,
        output: 64_000,
        cost: zeroCost,
        reasoning: true,
        temperature: true,
        tool_call: true,
        input_modalities: ['text', 'image', 'pdf'],
        output_modalities: ['text'],
        headers: {},
        options: {},
        variants: {
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
        },
      },
      'claude-haiku-4.5': {
        provider: 'anthropic',
        api_id: 'claude-haiku-4.5',
        status: 'active',
        context: 200_000,
        output: 32_000,
        cost: zeroCost,
        reasoning: true,
        temperature: true,
        tool_call: true,
        input_modalities: ['text', 'image', 'pdf'],
        output_modalities: ['text'],
        headers: {},
        options: {},
        variants: {
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
        },
      },
    },
  },
  profile: {
    main: {
      label: 'Main',
      description: '高质量编码任务的默认模型套件。',
      models: {
        primary: 'openai/gpt-5.5',
        small: 'openai/gpt-5.4',
        compact: 'openai/gpt-5.4',
        title: 'openai/gpt-5.4',
        review: 'anthropic/claude-sonnet-4.6',
      },
      settings: {
        primary: { reasoning_effort: 'medium' },
        small: { reasoning_effort: 'low' },
        compact: { reasoning_effort: 'low' },
        title: { reasoning_effort: 'low' },
        review: { reasoning_effort: 'high' },
      },
    },
    anthropic: {
      label: 'Anthropic',
      description: '偏向 Anthropic 的编码与审查模型套件。',
      models: {
        primary: 'anthropic/claude-sonnet-4.6',
        small: 'anthropic/claude-haiku-4.5',
        compact: 'anthropic/claude-haiku-4.5',
        title: 'anthropic/claude-haiku-4.5',
        review: 'anthropic/claude-opus-4.8',
      },
      settings: {
        primary: { reasoning_effort: 'medium' },
        small: { reasoning_effort: 'low' },
        compact: { reasoning_effort: 'low' },
        title: { reasoning_effort: 'low' },
        review: { reasoning_effort: 'high' },
      },
    },
  },
};

/**
 * 校验完整配置中的 provider、model 与 profile 引用关系。
 *
 * Args:
 * - `config`: 已通过 Zod 字段校验并合并内置 catalog 的配置；函数只读取其结构。
 *
 * Returns:
 * - 校验成功后返回 `void`，表示所有启用模型和 profile role 都可解析为唯一 model ref。
 *
 * Throws:
 * - 当 provider 缺失、model provider 不一致、model ref 重复或 profile 引用未知模型时抛错。
 */
export function validateProviderCatalog(config: CodingAgentConfig): void {
  const modelRefs = new Set<string>();
  for (const [providerId, models] of Object.entries(config.models)) {
    const provider = config.provider[providerId];
    if (provider === undefined) {
      throw new Error(`Model provider is not configured: ${providerId}`);
    }
    if (provider.enabled === false) {
      continue;
    }
    for (const [modelKey, model] of Object.entries(models)) {
      if (model.provider !== providerId) {
        throw new Error(
          `Model ${providerId}/${modelKey} declares provider ${model.provider}; expected ${providerId}.`,
        );
      }
      const ref = normalizeModelRef(
        `${providerId}/${model.id === undefined ? modelKey : model.id}`,
      );
      if (modelRefs.has(ref)) {
        throw new Error(`Duplicate model ref: ${ref}`);
      }
      modelRefs.add(ref);
    }
  }
  for (const [profileName, profile] of Object.entries(config.profile)) {
    for (const [role, configuredRef] of Object.entries(profile.models)) {
      const ref = normalizeModelRef(configuredRef);
      if (!modelRefs.has(ref)) {
        throw new Error(
          `Profile ${profileName} role ${role} references unknown model: ${ref}`,
        );
      }
    }
  }
  if (config.profile[config.active_profile] === undefined) {
    throw new Error(`Unknown active profile: ${config.active_profile}`);
  }
}

/**
 * 校验并返回 `provider/model` 形式的模型引用。
 *
 * Args:
 * - `value`: 配置、RPC 或内部 role binding 提供的原始模型引用。
 *
 * Returns:
 * - 返回未经改写的规范引用，供 Map key 与诊断共同使用。
 *
 * Throws:
 * - 当引用缺少任一 segment、包含多个斜杠或混入 variant 分隔符时抛错。
 */
export function normalizeModelRef(value: string): string {
  const slash = value.indexOf('/');
  if (
    slash <= 0 ||
    slash === value.length - 1 ||
    value.includes(':') ||
    value.indexOf('/', slash + 1) !== -1
  ) {
    throw new Error(`Invalid model ref "${value}". Expected "provider/model".`);
  }
  return value;
}
