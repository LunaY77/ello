/**
 * 本文件负责 model feature 的“registry”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { type AgentModel } from '../../../agent/engine/index.js';
import {
  normalizeModelRef,
  type CodingAgentConfig,
  ModelCatalogEntryConfig,
  ProviderConnectionConfig,
} from '../../../config/index.js';
import {
  createAiSdkLanguageModel,
  type AiSdkLanguageModelEndpoint,
} from '../ai-sdk/ai-sdk-provider.js';

import type {
  ModelRole,
  ModelRoleSettings,
  ProviderRegistry,
  RuntimeModel,
  RuntimeProfileSuite,
  RuntimeProvider,
  RuntimeRoleModel,
} from './types.js';
import { MODEL_ROLES } from './types.js';

/**
 * 构造 模型 `registry` 模块 中的 `createProviderRegistry` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 *
 * Returns:
 * - 返回 `createProviderRegistry` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 模型 `registry` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createProviderRegistry(
  config: CodingAgentConfig,
): ProviderRegistry {
  return new DefaultProviderRegistry(config);
}

class DefaultProviderRegistry implements ProviderRegistry {
  private readonly providers: Map<string, RuntimeProvider>;
  private readonly models: Map<string, RuntimeModel>;
  private readonly profiles: Map<string, RuntimeProfileSuite>;

  constructor(config: CodingAgentConfig) {
    this.providers = buildProviders(config, true);
    this.models = buildModels(config, this.providers);
    this.profiles = buildProfiles(config, this.models);
  }

  listProviders(): readonly RuntimeProvider[] {
    return [...this.providers.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  listModels(providerId?: string): readonly RuntimeModel[] {
    return [...this.models.values()]
      .filter(
        (model) => providerId === undefined || model.providerId === providerId,
      )
      .sort((a, b) => a.ref.localeCompare(b.ref));
  }

  listProfiles(): readonly RuntimeProfileSuite[] {
    return [...this.profiles.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  getProvider(providerId: string): RuntimeProvider {
    const provider = this.providers.get(providerId);
    if (provider === undefined) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return provider;
  }

  getModel(modelReference: string): RuntimeModel {
    const ref = normalizeModelRef(modelReference);
    const model = this.models.get(ref);
    if (model === undefined) {
      throw new Error(`Unknown model: ${modelReference}`);
    }
    return model;
  }

  getProfile(profileName: string): RuntimeProfileSuite {
    const profile = this.profiles.get(profileName);
    if (profile === undefined) {
      throw new Error(`Unknown profile: ${profileName}`);
    }
    return profile;
  }

  resolveRole(profileName: string, role: ModelRole): RuntimeRoleModel {
    const profile = this.getProfile(profileName);
    const ref = profile.models[role];
    const model = this.getModel(ref);
    return {
      profileName,
      role,
      ref,
      model,
      settings: profile.settings[role] ?? {},
    };
  }

  resolveLanguageModel(modelReference: string): AgentModel {
    const model = this.getModel(modelReference);
    const provider = this.getProvider(model.providerId);
    return createAiSdkLanguageModel({
      providerId: provider.id,
      providerKind: model.providerKind,
      modelId: model.apiId,
      endpoint: resolveAiSdkEndpoint(model),
      ...(provider.baseUrl !== undefined ? { baseURL: provider.baseUrl } : {}),
      ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
      headers: { ...provider.headers, ...model.headers },
      options: {
        ...provider.options,
      },
    });
  }
}

/** 校验 provider/model/profile 引用，但不读取凭证文件或环境变量。 */
function buildProviders(
  config: CodingAgentConfig,
  resolveCredentials: boolean,
): Map<string, RuntimeProvider> {
  const providers = new Map<string, RuntimeProvider>();
  for (const [id, provider] of Object.entries(config.provider)) {
    providers.set(
      id,
      runtimeProvider(id, provider, 'config', resolveCredentials),
    );
  }
  return providers;
}

function runtimeProvider(
  id: string,
  provider: ProviderConnectionConfig,
  source: RuntimeProvider['source'],
  resolveCredentials: boolean,
): RuntimeProvider {
  const apiKey = resolveCredentials ? resolveApiKey(provider) : undefined;
  return {
    id,
    name: provider.name ?? id,
    enabled: provider.enabled ?? true,
    kind: provider.kind,
    ...(provider.api_key_env !== undefined
      ? { apiKeyEnv: provider.api_key_env }
      : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(provider.base_url !== undefined
      ? { baseUrl: expandEnv(provider.base_url) }
      : {}),
    headers: expandHeaders(provider.headers ?? {}),
    options: provider.options ?? {},
    source,
  };
}

function buildModels(
  config: CodingAgentConfig,
  providers: Map<string, RuntimeProvider>,
): Map<string, RuntimeModel> {
  const models = new Map<string, RuntimeModel>();
  for (const [providerId, providerModels] of Object.entries(config.models)) {
    const provider = providers.get(providerId);
    if (provider === undefined) {
      throw new Error(`Model provider is not configured: ${providerId}`);
    }
    if (!provider.enabled) {
      continue;
    }
    for (const [modelId, model] of Object.entries(providerModels)) {
      const runtime = runtimeModel(provider, modelId, model);
      models.set(runtime.ref, runtime);
    }
  }
  return models;
}

function runtimeModel(
  provider: RuntimeProvider,
  modelId: string,
  model: ModelCatalogEntryConfig,
): RuntimeModel {
  if (model.provider !== provider.id) {
    throw new Error(
      `Model ${provider.id}/${modelId} declares provider ${model.provider}; expected ${provider.id}.`,
    );
  }
  const id = model.id ?? modelId;
  return {
    ref: `${provider.id}/${id}`,
    providerId: provider.id,
    id,
    name: model.name ?? id,
    apiId: model.api_id,
    providerKind: provider.kind,
    ...(model.endpoint !== undefined ? { endpoint: model.endpoint } : {}),
    status: model.status,
    ...(model.release_date !== undefined
      ? { releaseDate: model.release_date }
      : {}),
    capabilities: {
      temperature: model.temperature,
      reasoning: model.reasoning,
      toolCall: model.tool_call,
      input: model.input_modalities,
      output: model.output_modalities,
      ...(model.interleaved_reasoning_field !== undefined
        ? { interleavedReasoningField: model.interleaved_reasoning_field }
        : {}),
    },
    limit: {
      context: model.context,
      output: model.output,
    },
    pricing: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cache_read,
      cacheWrite: model.cost.cache_write,
    },
    headers: model.headers ?? {},
    options: model.options ?? {},
    variants: model.variants ?? {},
  };
}

function buildProfiles(
  config: CodingAgentConfig,
  models: Map<string, RuntimeModel>,
): Map<string, RuntimeProfileSuite> {
  const profiles = new Map<string, RuntimeProfileSuite>();
  for (const [name, profile] of Object.entries(config.profile)) {
    const roleModels = {
      primary: resolveProfileModel(
        name,
        'primary',
        profile.models.primary,
        models,
      ),
      small: resolveProfileModel(name, 'small', profile.models.small, models),
      compact: resolveProfileModel(
        name,
        'compact',
        profile.models.compact,
        models,
      ),
      title: resolveProfileModel(name, 'title', profile.models.title, models),
      review: resolveProfileModel(
        name,
        'review',
        profile.models.review,
        models,
      ),
    } satisfies Record<ModelRole, string>;
    const settings: Partial<Record<ModelRole, ModelRoleSettings>> = {};
    for (const role of MODEL_ROLES) {
      const roleSettings = profile.settings[role];
      if (roleSettings !== undefined) {
        settings[role] = normalizeRoleSettings(roleSettings);
      }
    }
    profiles.set(name, {
      name,
      ...(profile.label !== undefined ? { label: profile.label } : {}),
      ...(profile.description !== undefined
        ? { description: profile.description }
        : {}),
      models: roleModels,
      settings,
    });
  }
  const active = config.active_profile;
  if (!profiles.has(active)) {
    throw new Error(`Unknown active profile: ${active}`);
  }
  return profiles;
}

function resolveProfileModel(
  profileName: string,
  role: ModelRole,
  modelReference: string,
  models: ReadonlyMap<string, RuntimeModel>,
): string {
  const ref = normalizeModelRef(modelReference);
  if (!models.has(ref)) {
    throw new Error(
      `Profile ${profileName} role ${role} references unknown model: ${ref}`,
    );
  }
  return ref;
}

function normalizeRoleSettings(
  settings: NonNullable<
    CodingAgentConfig['profile'][string]['settings'][ModelRole]
  >,
): ModelRoleSettings {
  return {
    ...(settings.reasoning_effort !== undefined
      ? { reasoningEffort: settings.reasoning_effort }
      : {}),
    ...(settings.temperature !== undefined
      ? { temperature: settings.temperature }
      : {}),
    ...(settings.top_p !== undefined ? { topP: settings.top_p } : {}),
    ...(settings.top_k !== undefined ? { topK: settings.top_k } : {}),
    ...(settings.provider_options !== undefined
      ? { providerOptions: settings.provider_options }
      : {}),
  };
}

function resolveApiKey(provider: ProviderConnectionConfig): string | undefined {
  const configured = expandSecret(provider.api_key);
  if (configured !== undefined) {
    return configured;
  }
  if (provider.api_key_file !== undefined) {
    return readSecretFile(provider.api_key_file);
  }
  return provider.api_key_env !== undefined
    ? process.env[provider.api_key_env]
    : undefined;
}

function readSecretFile(keyPath: string): string {
  const text = readFileSync(expandHome(expandEnv(keyPath)), 'utf8').trim();
  if (text === '') {
    throw new Error(`Provider auth file is empty: ${keyPath}`);
  }
  return text;
}

function expandHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, expandEnv(value)]),
  );
}

function expandEnv(value: string): string {
  return value.replace(
    /\$\{([^}]+)\}/gu,
    (match, key) => process.env[String(key)] ?? match,
  );
}

function expandSecret(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const expanded = expandEnv(value).trim();
  return expanded === '' ? undefined : expanded;
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/')
    ? path.join(homedir(), value.slice(2))
    : value;
}

function resolveAiSdkEndpoint(model: RuntimeModel): AiSdkLanguageModelEndpoint {
  if (model.providerKind === 'anthropic') {
    return 'languageModel';
  }
  if (model.endpoint === undefined) {
    throw new Error(
      `Model ${model.ref} requires endpoint for provider kind ${model.providerKind}.`,
    );
  }
  return model.endpoint;
}
