import type {
  ModelCatalogEntryConfig,
  ProfileSuiteConfig,
  ProviderConnectionConfig,
} from '../../../config/schema.js';
import type { AgentModel, AiSdkProviderKind } from '../../engine/index.js';


export type ModelRole = 'primary' | 'small' | 'compact' | 'title' | 'review';

export const MODEL_ROLES: readonly ModelRole[] = [
  'primary',
  'small',
  'compact',
  'title',
  'review',
];

export type ModelEndpoint = 'languageModel' | 'chat' | 'responses' | 'custom';
export type ModelModality = 'text' | 'audio' | 'image' | 'video' | 'pdf';

export interface ModelPricing {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export interface ModelCapabilities {
  readonly temperature: boolean;
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly input: readonly ModelModality[];
  readonly output: readonly ModelModality[];
  readonly interleavedReasoningField?: string;
}

export interface ModelRoleSettings {
  readonly reasoningEffort?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly providerOptions?: Record<string, unknown>;
}

export interface RuntimeProvider {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly kind: AiSdkProviderKind;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly headers: Record<string, string>;
  readonly options: Record<string, unknown>;
  readonly source: 'builtin' | 'config';
}

export interface RuntimeModel {
  readonly ref: string;
  readonly providerId: string;
  readonly id: string;
  readonly name: string;
  readonly apiId: string;
  readonly providerKind: AiSdkProviderKind;
  readonly endpoint?: ModelEndpoint;
  readonly status: 'active' | 'beta' | 'alpha';
  readonly releaseDate?: string;
  readonly capabilities: ModelCapabilities;
  readonly limit: { readonly context: number; readonly output: number };
  readonly pricing?: ModelPricing;
  readonly headers: Record<string, string>;
  readonly options: Record<string, unknown>;
  readonly variants: Record<string, Record<string, unknown>>;
}

export interface RuntimeProfileSuite {
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
  readonly models: Record<ModelRole, string>;
  readonly settings: Partial<Record<ModelRole, ModelRoleSettings>>;
}

export interface RuntimeRoleModel {
  readonly profileName: string;
  readonly role: ModelRole;
  readonly ref: string;
  readonly model: RuntimeModel;
  readonly settings: ModelRoleSettings;
}

export interface ProviderCatalog {
  readonly provider: Record<string, ProviderConnectionConfig>;
  readonly models: Record<string, Record<string, ModelCatalogEntryConfig>>;
  readonly profile: Record<string, ProfileSuiteConfig>;
}

export interface ProviderRegistry {
  listProviders(): readonly RuntimeProvider[];
  listModels(providerId?: string): readonly RuntimeModel[];
  listProfiles(): readonly RuntimeProfileSuite[];
  getProvider(providerId: string): RuntimeProvider;
  getModel(modelReference: string): RuntimeModel;
  getProfile(profileName: string): RuntimeProfileSuite;
  resolveRole(profileName: string, role: ModelRole): RuntimeRoleModel;
  resolveLanguageModel(
    modelReference: string,
    settings?: ModelRoleSettings,
  ): AgentModel;
}

export interface ProfileRegistry {
  listProfiles(): readonly RuntimeProfileSuite[];
  getProfile(profileName: string): RuntimeProfileSuite;
  resolveRole(profileName: string, role: ModelRole): RuntimeRoleModel;
}
