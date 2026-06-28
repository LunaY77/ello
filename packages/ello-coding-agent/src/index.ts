/**
 * `@ello/coding-agent` 公共入口。
 *
 * 这是 `@ello/agent` 运行时之上的薄产品层。对外只暴露：共享运行时
 * （{@link createCodingSession}）、配置装配、权限/规则、工具集、上下文与系统
 * 提示、会话存储、检查点、技能/子代理、以及两个前端入口（CLI / TUI）。
 */

// —— 配置 ——
export {
  ApprovalModeSchema,
  CodingAgentConfigSchema,
  getProjectConfigPath,
  loadCodingAgentConfig,
  normalizeApprovalMode,
  setProjectConfigValue,
  type ApprovalMode,
  type CodingAgentConfig,
  type CodingAgentConfigOverrides,
} from './config.js';

// —— 共享运行时 ——
export {
  createCodingSession,
  type CodingSession,
  type CreateCodingSessionOptions,
} from './runtime/coding-session.js';
export type {
  ApprovalDecision,
  CodingSessionState,
  CodingSessionEvent,
  CodingEventListener,
} from './runtime/intents.js';

// —— 会话存储与会话树 ——
export { JsonlSessionStore } from './session/jsonl-store.js';
export {
  JsonlSessionRepository,
  SESSION_FILE_VERSION,
  type ActiveSessionPath,
  type JsonlSessionSummary,
  type SessionTreeNode,
  type SessionTreeView,
  type SessionRecord,
} from './session/repository.js';

// —— 权限与规则 ——
export {
  applyPermissionPolicy,
  denialKey,
  evaluateToolPermission,
  formatPermissionRules,
  parsePermissionRules,
  PermissionModeSchema,
  PermissionRuleSchema,
  type PermissionAction,
  type PermissionContext,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRule,
} from './permissions.js';
export { makeApprovalPolicy } from './permission/policy.js';
export { RulesStore, type RuleScope } from './permission/rules-store.js';

// —— 工具集 ——
export {
  createCodingTools,
  describeCodingTools,
  type CreateCodingToolsOptions,
} from './tools/index.js';

// —— 上下文与系统提示 ——
export { buildCodingSystemPrompt } from './system-prompt.js';
export { buildSystemSections, loadProjectInstructions } from './context/sections.js';
export { createCodingMemory } from './context/memory.js';
export { createSessionCompactor } from './context/compactor.js';
export {
  loadCodingMemory,
  renderMemoryForPrompt,
  summarizeMemory,
  type MemoryFile,
  type MemoryManifest,
} from './memory.js';

// —— 改动与检查点 ——
export {
  CheckpointStore,
  type Checkpoint,
  type FileChange,
} from './change/checkpoint.js';

// —— 技能与子代理 ——
export { loadCodingSkills } from './skills.js';
export { codingSubagents } from './subagents.js';

// —— 可观测 ——
export { createCodingObserver, summarizeUsage } from './observability/observer.js';

// —— slash 命令 ——
export {
  slashCommands,
  handleSlashCommand,
  type CommandContext,
  type CommandResult,
  type SlashCommand,
  type SlashCommandResult,
} from './slash-commands.js';

// —— 前端入口 ——
export { buildProgram, runCli, type CliIo } from './cli/main.js';
export { launchTui, type LaunchTuiOptions } from './tui/index.js';
