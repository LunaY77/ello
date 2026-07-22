/**
 * 本文件负责 model feature 的领域类型与闭合联合。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type {
  AgentModel,
  AgentModelSettings,
} from '../../../agent/engine/index.js';
import type { AiSdkProviderKind } from '../ai-sdk/ai-sdk-provider.js';

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
  readonly reasoningEffort?: NonNullable<AgentModelSettings['reasoning']>;
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

export interface ProviderRegistry {
  /**
   * 读取 模型 `types` 模块 的 `listProviders` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  listProviders(): readonly RuntimeProvider[];
  /**
   * 读取 模型 `types` 模块 的 `listModels` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `providerId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  listModels(providerId?: string): readonly RuntimeModel[];
  /**
   * 读取 模型 `types` 模块 的 `listProfiles` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  listProfiles(): readonly RuntimeProfileSuite[];
  /**
   * 读取 模型 `types` 模块 的 `getProvider` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `providerId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - 返回 `getProvider` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  getProvider(providerId: string): RuntimeProvider;
  /**
   * 读取 模型 `types` 模块 的 `getModel` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `modelReference`: `getModel` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `getModel` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  getModel(modelReference: string): RuntimeModel;
  /**
   * 读取 模型 `types` 模块 的 `getProfile` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `profileName`: `getProfile` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `getProfile` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  getProfile(profileName: string): RuntimeProfileSuite;
  /**
   * 在 模型 `types` 模块 中执行 `resolveRole` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `profileName`: `resolveRole` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `role`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
   *
   * Returns:
   * - 返回 `resolveRole` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 模型 `types` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  resolveRole(profileName: string, role: ModelRole): RuntimeRoleModel;
  /**
   * 在 模型 `types` 模块 中执行 `resolveLanguageModel` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `modelReference`: `resolveLanguageModel` 所需的业务值；函数按声明读取，不补造缺失内容。
   * Returns:
   * - 返回 `resolveLanguageModel` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 模型 `types` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  resolveLanguageModel(modelReference: string): AgentModel;
}

export interface ProfileRegistry {
  /**
   * 读取 模型 `types` 模块 的 `listProfiles` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  listProfiles(): readonly RuntimeProfileSuite[];
  /**
   * 读取 模型 `types` 模块 的 `getProfile` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `profileName`: `getProfile` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `getProfile` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  getProfile(profileName: string): RuntimeProfileSuite;
  /**
   * 在 模型 `types` 模块 中执行 `resolveRole` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `profileName`: `resolveRole` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `role`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
   *
   * Returns:
   * - 返回 `resolveRole` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 模型 `types` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  resolveRole(profileName: string, role: ModelRole): RuntimeRoleModel;
}
