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
  getConfigValue,
  getProjectConfigPath,
  loadCodingAgentConfig,
  loadConfigSources,
  normalizeApprovalMode,
  setConfigValue,
  type ConfigSourceName,
  type LoadedConfigSource,
  type WritableConfigSourceName,
} from './loader.js';
export {
  globalCacheDir,
  globalConfigPath,
  globalGitignorePath,
  globalHomeDir,
  globalLogsDir,
  globalMcpPath,
  globalSessionsDir,
  globalSkillsDir,
  globalSubagentsDir,
  globalTasksDir,
  globalWorkspacesDir,
  projectConfigPath,
  projectElloDir,
  projectSkillsDir,
  projectTasksDir,
  projectWorkspacePointerPath,
} from './paths.js';
export {
  ApprovalModeSchema,
  CodingAgentConfigSchema,
  PermissionRuleSchema,
  type ApprovalMode,
  type CodingAgentConfig,
  type CodingAgentConfigOverrides,
  type PermissionRule,
} from './schema.js';
