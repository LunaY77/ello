/**
 * config 模块的公开出口。
 *
 * 外部模块只从这里导入配置能力，避免直接依赖 loader/schema/paths 的内部文件布局。
 */
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
  normalizeApprovalMode,
  setConfigValue,
  setConfigValues,
  type ConfigSourceName,
  type LoadedConfigSource,
  type WritableConfigSourceName,
} from './loader.js';
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
  globalTasksDir,
  globalWorkspacesDir,
  projectAgentsDir,
  projectConfigPath,
  projectElloDir,
  projectSkillsDir,
  projectTasksDir,
  projectWorkspacePointerPath,
} from './paths.js';
export {
  AgentConfigSchema,
  AgentModeSchema,
  AgentRoleSchema,
  ApprovalModeSchema,
  CodingAgentConfigSchema,
  ModelCatalogEntrySchema,
  ModelRoleSettingsSchema,
  PermissionRuleSchema,
  ProfileSuiteSchema,
  ProviderConnectionSchema,
  ToolConfigSchema,
  type AgentConfigEntry,
  type ApprovalMode,
  type CodingAgentConfig,
  type CodingAgentConfigOverrides,
  type ModelCatalogEntryConfig,
  type ModelRoleSettingsConfig,
  type PermissionRule,
  type ProfileSuiteConfig,
  type ProviderConnectionConfig,
  type ToolConfig,
} from './schema.js';
