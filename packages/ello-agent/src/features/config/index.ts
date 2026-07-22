/**
 * 本文件负责 config feature 的公开入口与 factory。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { loadCodingAgentConfig } from './load.js';
import { createConfigRoutes } from './routes.js';

/**
 * 构造 配置 公开入口 模块 中的 `createConfigFeature` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `createConfigFeature` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 配置 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createConfigFeature() {
  return {
    load: loadCodingAgentConfig,
    routes: createConfigRoutes(),
  };
}

export { sanitizeConfigForResponse } from './response.js';
export { atomicWriteText } from './atomic-write.js';
export {
  ensureBuiltinAssets,
  ensureElloHome,
  ensureGlobalConfig,
  ensureProjectConfig,
} from './initializer.js';
export {
  deleteConfigValues,
  getConfigValue,
  getProjectConfigPath,
  loadCodingAgentConfig,
  loadConfigSources,
  setConfigValue,
  setConfigValues,
  writeConfigPath,
  ConfigValidationError,
  type ConfigSourceName,
  type LoadedConfigSource,
  type WritableConfigSourceName,
} from './load.js';
export {
  globalAgentsDir,
  globalCacheDir,
  globalConfigPath,
  globalGitignorePath,
  globalHomeDir,
  globalLogsDir,
  globalMcpPath,
  globalSessionsDir,
  globalSkillsDir,
  projectAgentsDir,
  projectConfigPath,
  projectElloDir,
  projectPermissionsFile,
  projectSkillsDir,
  userPermissionsFile,
} from './paths.js';
export {
  AgentConfigSchema,
  AgentModeSchema,
  AgentRoleSchema,
  CodingAgentConfigSchema,
  GoalConfigSchema,
  LangfuseObservabilityConfigSchema,
  ObservabilityConfigSchema,
  ModelCatalogEntrySchema,
  ModelRoleSettingsSchema,
  PermissionActionSchema,
  PermissionRuleSchema,
  PermissionScopeSchema,
  ProfileSuiteSchema,
  ProviderConnectionSchema,
  ToolConfigSchema,
  WorkspaceConfigSchema,
  type AgentConfigEntry,
  type CodingAgentConfig,
  type ContextCompactionConfig,
  type CodingAgentConfigOverrides,
  type GoalConfig,
  type LangfuseObservabilityConfig,
  type LangfuseTracingConfig,
  type ObservabilityConfig,
  type ModelCatalogEntryConfig,
  type ModelRoleSettingsConfig,
  type PermissionAction,
  type PermissionRule,
  type PermissionScope,
  type ProfileSuiteConfig,
  type ProviderConnectionConfig,
  type ToolConfig,
  type WorkspaceConfig,
} from './schema.js';
export {
  describeConfigSettings,
  type ConfigSettingDescriptor,
  type ConfigSettingEffect,
  type ConfigSettingValueType,
} from './settings.js';
export {
  deleteYamlConfigValues,
  parseYamlConfig,
  stringifyYamlConfig,
  updateYamlConfigValues,
} from './yaml.js';
export {
  builtinProviderCatalog,
  normalizeModelRef,
  validateProviderCatalog,
  type ProviderCatalog,
} from './provider-catalog.js';
