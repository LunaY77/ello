/** `@ello/coding-agent` 的稳定产品层入口。 */
export {
  CodingAgentConfigSchema,
  getProjectConfigPath,
  loadCodingAgentConfig,
  PermissionRuleSchema,
  type CodingAgentConfig,
  type CodingAgentConfigOverrides,
} from './config/index.js';

export {
  createCodingSession,
  type CodingMemoryStatus,
  type CodingSession,
  type CreateCodingSessionOptions,
} from './runtime/coding-session.js';
export {
  PlanModeError,
  SessionModeSchema,
  modeLabel,
  type SessionMode,
  type SessionModeState,
} from './runtime/session-mode.js';
export type {
  PlanCommandResult,
  PlanPreview,
  PlanRecord,
  PlanSlashCommand,
} from './plan/index.js';
export type { MemoryJob, MemoryStatus } from './memory/index.js';
export type {
  GoalPauseReason,
  GoalState,
  GoalStatus,
  GoalStatusView,
} from './goal/types.js';
export type {
  ApprovalDecision,
  CodingEventListener,
  CodingSessionEvent,
  CodingSessionState,
} from './runtime/intents.js';

export type {
  PermissionAction,
  PermissionDescriptor,
  PermissionMetadata,
  PermissionRequest,
  PermissionRule,
  PermissionScope,
} from './permissions.js';

export { buildProgram, runCli, type CliIo } from './cli/main.js';
export { launchTui, type LaunchTuiOptions } from './tui/index.js';
