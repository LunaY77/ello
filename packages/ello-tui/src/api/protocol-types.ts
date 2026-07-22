export type {
  AppServerErrorType,
  ApprovalDecision,
  ClientMethod,
  ClientNotificationMethod,
  ClientNotificationParams,
  ClientParams,
  ClientResult,
  FileChange,
  Goal,
  InitializeParamsSchema,
  PendingServerRequest,
  Plan,
  RpcRequestId,
  ServerNotification,
  ServerNotificationMethod,
  ServerRequest,
  ServerRequestMethod,
  ServerRequestResult,
  SessionMode,
  ThreadItem,
  ToolThreadItem,
  ThreadSettings,
  ThreadSnapshot,
  ThreadStatus,
  ThreadSummary,
  Turn,
  UserInput,
  UserInputResolution,
  Usage,
} from '@ello/agent/protocol';

export { JsonValueSchema } from '@ello/agent/protocol';

import type { ClientResult as ProtocolClientResult } from '@ello/agent/protocol';

export type CatalogEntry = ProtocolClientResult<'model/list'>['data'][number];
export type Task = ProtocolClientResult<'task/list'>['data'][number];
export type MemoryStatus = ProtocolClientResult<'memory/status'>;
export type AgentSkill = ProtocolClientResult<'skills/list'>['data'][number];
export type ModelCatalogEntry =
  ProtocolClientResult<'model/list'>['data'][number];
export type ProviderCatalogEntry =
  ProtocolClientResult<'provider/list'>['data'][number];
export type AgentCatalogEntry =
  ProtocolClientResult<'agent/list'>['data'][number];
export type WorkspaceSummary =
  ProtocolClientResult<'workspace/list'>['data'][number];

export { cycleSessionMode, isToolItem } from '@ello/agent/protocol';
