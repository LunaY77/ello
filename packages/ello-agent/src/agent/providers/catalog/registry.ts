import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';


import type { CodingAgentConfig } from '../../../config/index.js';
import type {
  ModelCatalogEntryConfig,
  ProviderConnectionConfig,
} from '../../../config/schema.js';
import {
  createAiSdkLanguageModel,
  type AgentModel,
  type AiSdkLanguageModelEndpoint,
  type AiSdkProviderKind,
} from '../../engine/index.js';

import { builtinProviderCatalog } from './catalog.js';
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
    this.providers = buildProviders(config);
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

  resolveLanguageModel(
    modelReference: string,
    settings: ModelRoleSettings = {},
  ): AgentModel {
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
        ...model.options,
        ...(settings.providerOptions ?? {}),
      },
    });
  }
}

function buildProviders(
  config: CodingAgentConfig,
): Map<string, RuntimeProvider> {
  const providers = new Map<string, RuntimeProvider>();
  for (const [id, provider] of Object.entries({
    ...builtinProviderCatalog.provider,
    ...config.provider,
  })) {
    providers.set(
      id,
      runtimeProvider(
        id,
        provider,
        id in config.provider ? 'config' : 'builtin',
      ),
    );
  }
  return providers;
}

function runtimeProvider(
  id: string,
  provider: ProviderConnectionConfig,
  source: RuntimeProvider['source'],
): RuntimeProvider {
  const apiKey = resolveApiKey(provider);
  return {
    id,
    name: provider.name ?? id,
    enabled: provider.enabled ?? true,
    kind: provider.kind as AiSdkProviderKind,
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
  const mergedModels = mergeNestedModels(
    builtinProviderCatalog.models,
    config.models,
  );
  for (const [providerId, providerModels] of Object.entries(mergedModels)) {
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
    providerKind: provider.kind as AiSdkProviderKind,
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
    const roleModels = Object.fromEntries(
      MODEL_ROLES.map((role) => {
        const ref = normalizeModelRef(profile.models[role]);
        if (!models.has(ref)) {
          throw new Error(
            `Profile ${name} role ${role} references unknown model: ${ref}`,
          );
        }
        return [role, ref];
      }),
    ) as Record<ModelRole, string>;
    profiles.set(name, {
      name,
      ...(profile.label !== undefined ? { label: profile.label } : {}),
      ...(profile.description !== undefined
        ? { description: profile.description }
        : {}),
      models: roleModels,
      settings: Object.fromEntries(
        Object.entries(profile.settings).map(([role, settings]) => [
          role,
          normalizeRoleSettings(settings ?? {}),
        ]),
      ) as RuntimeProfileSuite['settings'],
    });
  }
  const active = config.active_profile;
  if (!profiles.has(active)) {
    throw new Error(`Unknown active profile: ${active}`);
  }
  return profiles;
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

function mergeNestedModels(
  base: Record<string, Record<string, ModelCatalogEntryConfig>>,
  override: Record<string, Record<string, ModelCatalogEntryConfig>>,
): Record<string, Record<string, ModelCatalogEntryConfig>> {
  const result: Record<string, Record<string, ModelCatalogEntryConfig>> = {};
  for (const [providerId, models] of Object.entries(base)) {
    result[providerId] = { ...models };
  }
  for (const [providerId, models] of Object.entries(override)) {
    result[providerId] = { ...(result[providerId] ?? {}), ...models };
  }
  return result;
}

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
  return model.endpoint as AiSdkLanguageModelEndpoint;
}
