/** `@ello/coding-agent` 的稳定产品层入口。 */
export {
  ApprovalModeSchema,
  CodingAgentConfigSchema,
  getProjectConfigPath,
  loadCodingAgentConfig,
  normalizeApprovalMode,
  PermissionRuleSchema,
  type ApprovalMode,
  type CodingAgentConfig,
  type CodingAgentConfigOverrides,
} from './config/index.js';

export {
  createCodingSession,
  type CodingMemoryStatus,
  type CodingSession,
  type CreateCodingSessionOptions,
} from './runtime/coding-session.js';
export type { MemoryJob, MemoryStatus } from './memory/index.js';
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
