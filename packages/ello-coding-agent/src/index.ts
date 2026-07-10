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
  type ApprovalMode,
  type CodingAgentConfig,
  type CodingAgentConfigOverrides,
} from './config/index.js';

// —— 共享运行时 ——
export {
  createCodingSession,
  type CodingSession,
  type CreateCodingSessionOptions,
} from './runtime/coding-session.js';
export type {
  ApprovalDecision,
  CodingEventListener,
  CodingSessionEvent,
  CodingSessionState,
} from './runtime/intents.js';

// —— 会话存储与会话树 ——
export { JsonlSessionStore } from './session/jsonl-store.js';
export {
  JsonlSessionRepository,
  SESSION_FILE_VERSION,
  type ActiveSessionPath,
  type JsonlSessionSummary,
  type SessionRecord,
  type SessionTreeNode,
  type SessionTreeView,
} from './session/repository.js';

// —— 权限与规则 ——
export { makeApprovalPolicy } from './permission/policy.js';
export { RulesStore, type RuleScope } from './permission/rules-store.js';
export {
  defaultRulesetForMode,
  evaluatePermission,
  formatPermissionRules,
  isExternalPath,
  isPathInside,
  parsePermissionRules,
  resolveAbsolute,
  PermissionRuleSchema,
  wildcardMatch,
  type PermissionAction,
  type PermissionDescriptor,
  type PermissionMetadata,
  type PermissionRequest,
  type PermissionRule,
  type PermissionScope,
} from './permissions.js';

// —— 工具集 ——
export {
  createCodingTools,
  describeCodingTools,
  type CreateCodingToolsOptions,
} from './tools/index.js';

// —— 上下文与系统提示 ——
export { createSessionCompactor } from './context/compactor.js';
export { createCodingMemory } from './context/memory.js';
export { loadInstructionSources } from './context/instructions.js';
export {
  loadContextBundle,
  renderContextSource,
  renderContextSources,
  type ContextBundle,
  type ContextDiagnostic,
  type ContextEvent,
  type ContextSource,
} from './context/source-registry.js';
export {
  buildContextBundle,
  buildCodingSystemPrompt,
  createCodingSystemPromptSection,
  loadProjectInstructions,
  renderPromptTemplate,
} from './context/prompts.js';
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

// —— 技能 ——
export {
  formatSkill,
  formatSkillList,
  loadCodingSkills,
} from './skills/index.js';

// —— Agent 编排 ——
export {
  BackgroundJobStore,
  builtinAgents,
  createAgentRegistry,
  createDelegateTool,
  createSubagentAgent,
  deriveSubagentPermission,
  loadMarkdownAgents,
  renderSubagentEnvelope,
  runInternalAgent,
  runSubagent,
  type AgentRegistry,
  type BackgroundJob,
  type CodingAgentDefinition,
  type CodingAgentMode,
  type CodingAgentSource,
  type CreateDelegateToolOptions,
  type DelegateToolHooks,
  type SubagentAgentDeps,
  type SubagentRun,
  type SubagentRunDeps,
} from './agents/index.js';

// —— 持久化任务 ——
export {
  createTaskService,
  formatClaimResult,
  formatTask,
  formatTaskList,
  TaskService,
  type ClaimResult,
  type CreateTaskInput,
  type Task,
  type TaskBoard,
  type TaskBoardScope,
  type TaskRef,
  type TaskStatus,
  type UpdateTaskInput,
} from './tasks/index.js';

// —— 全局 SQLite 状态库 ——
export {
  createCodingStorage,
  globalArtifactsDir,
  globalStateDatabasePath,
  transaction,
  withCodingStorage,
  type CodingDatabase,
  type CodingStorage,
} from './storage/index.js';
export { CheckpointRepository } from './storage/repositories/checkpoint-repository.js';
export { MemoryRepository } from './storage/repositories/memory-repository.js';
export { TaskBoardRepository } from './storage/repositories/task-board-repository.js';
export { UsageRepository } from './storage/repositories/usage-repository.js';
export { WorkspaceRepository } from './storage/repositories/workspace-repository.js';

// —— 多仓 workspace ——
export {
  formatRepoList,
  formatWorkspaceList,
  RepoStore,
  WorkspaceStore,
  type RepoEntry,
  type WorkspaceKind,
  type WorkspaceManifest,
  type WorkspaceRepo,
} from './workspace/index.js';

// —— 可观测 ——
export {
  createCodingObserver,
  summarizeUsage,
} from './observability/observer.js';

// —— slash 命令 ——
export {
  handleSlashCommand,
  slashCommands,
  type CommandContext,
  type CommandResult,
  type SlashCommand,
  type SlashCommandResult,
} from './slash-commands.js';

// —— 前端入口 ——
export { buildProgram, runCli, type CliIo } from './cli/main.js';
export { launchTui, type LaunchTuiOptions } from './tui/index.js';
