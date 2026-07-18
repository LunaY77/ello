import { z } from 'zod';

import {
  CapabilitySchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  NonNegativeIntegerSchema,
  OpaqueIdSchema,
  ProtocolVersionSchema,
} from './common.js';
import {
  CLIENT_REQUEST_SCHEMAS,
  type ClientMethod,
} from './requests.js';
import {
  GoalSchema,
  PlanSchema,
  ThreadItemSchema,
  ThreadSettingsSchema,
  ThreadSnapshotSchema,
  ThreadSummarySchema,
  TurnSchema,
} from './resources.js';

export const InitializeResultSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    serverInfo: z
      .object({ name: z.literal('ello-agent'), version: z.string().min(1) })
      .strict(),
    serverCapabilities: z
      .object({
        transports: z
          .array(z.enum(['stdio', 'websocket', 'unix']))
          .readonly(),
        methods: z.array(z.string().min(1)).readonly(),
        notifications: z.array(z.string().min(1)).readonly(),
        serverRequests: z.array(z.string().min(1)).readonly(),
        granted: z.array(CapabilitySchema).readonly(),
      })
      .strict(),
  })
  .strict();

const AckSchema = z.object({ ok: z.literal(true) }).strict();
const EmptyResultSchema = z.object({}).strict();
const ThreadListResultSchema = z
  .object({
    data: z.array(ThreadSummarySchema).readonly(),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
const TurnListResultSchema = z
  .object({
    data: z.array(TurnSchema).readonly(),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
const ItemListResultSchema = z
  .object({
    data: z.array(ThreadItemSchema).readonly(),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

const CatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    enabled: z.boolean(),
    metadata: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict();
const CatalogResultSchema = z
  .object({ data: z.array(CatalogEntrySchema).readonly() })
  .strict();

const TaskSchema = z
  .object({
    id: OpaqueIdSchema,
    boardId: z.string().min(1),
    subject: z.string().min(1),
    description: z.string(),
    activeForm: z.string().optional(),
    status: z.enum(['pending', 'inProgress', 'completed', 'cancelled']),
    owner: z.string().nullable(),
    blockedBy: z.array(OpaqueIdSchema).readonly(),
    metadata: z.record(z.string(), JsonValueSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
const TaskListResultSchema = z
  .object({
    data: z.array(TaskSchema).readonly(),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

const FileMetadataSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(['file', 'directory', 'symlink']),
    size: NonNegativeIntegerSchema,
    modifiedAt: IsoDateTimeSchema,
  })
  .strict();
const DirectoryEntrySchema = FileMetadataSchema.pick({ path: true, kind: true })
  .extend({ name: z.string().min(1) })
  .strict();

const RepositorySchema = z
  .object({
    id: OpaqueIdSchema,
    key: z.string().min(1),
    sourceUrl: z.string().nullable(),
    mirrorPath: z.string().nullable(),
    defaultBranch: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
const WorkspaceSchema = z
  .object({
    id: OpaqueIdSchema,
    kind: z.enum(['feature', 'fix', 'refactor', 'explore']),
    name: z.string().min(1),
    rootPath: z.string().min(1),
    status: z.enum(['active', 'archived', 'missing', 'deleted']),
    branch: z.string().nullable(),
    repositories: z.array(JsonValueSchema).readonly(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

const RepositoryListSchema = z
  .object({ data: z.array(RepositorySchema).readonly() })
  .strict();
const WorkspaceListSchema = z
  .object({ data: z.array(WorkspaceSchema).readonly() })
  .strict();
const RepositoryOperationSchema = z
  .object({ repository: RepositorySchema })
  .strict();
const WorkspaceOperationSchema = z
  .object({ workspace: WorkspaceSchema })
  .strict();

/**
 * 返回值 schema 与请求 method 一一对应。新增 method 时少任意一项都会触发类型错误。
 */
export const CLIENT_RESPONSE_SCHEMAS = {
  initialize: InitializeResultSchema,
  'server/read': z
    .object({
      protocolVersion: ProtocolVersionSchema,
      version: z.string().min(1),
      state: z.enum(['starting', 'ready', 'stopping', 'stopped']),
      uptimeMs: NonNegativeIntegerSchema,
      capabilities: z.array(CapabilitySchema).readonly(),
    })
    .strict(),
  'server/shutdown': AckSchema,
  'thread/start': ThreadSnapshotSchema,
  'thread/resume': ThreadSnapshotSchema,
  'thread/read': ThreadSnapshotSchema,
  'thread/list': ThreadListResultSchema,
  'thread/loaded/list': z
    .object({ data: z.array(ThreadSummarySchema).readonly() })
    .strict(),
  'thread/fork': ThreadSnapshotSchema,
  'thread/unsubscribe': AckSchema,
  'thread/archive': z.object({ thread: ThreadSummarySchema }).strict(),
  'thread/unarchive': z.object({ thread: ThreadSummarySchema }).strict(),
  'thread/delete': AckSchema,
  'thread/turns/list': TurnListResultSchema,
  'thread/items/list': ItemListResultSchema,
  'thread/export': z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('inline'),
        content: z.string(),
        mediaType: z.string().min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal('artifact'),
        artifactId: OpaqueIdSchema,
        byteCount: NonNegativeIntegerSchema,
        mediaType: z.string().min(1),
      })
      .strict(),
  ]),
  'thread/compact/start': z.object({ jobId: OpaqueIdSchema }).strict(),
  'thread/shellCommand': z
    .object({
      exitCode: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
      durationMs: NonNegativeIntegerSchema,
      artifactId: OpaqueIdSchema.optional(),
    })
    .strict(),
  'thread/settings/update': ThreadSettingsSchema,
  'turn/start': z.object({ turn: TurnSchema }).strict(),
  'turn/steer': AckSchema,
  'turn/interrupt': z.object({ turn: TurnSchema }).strict(),
  'thread/goal/get': z.object({ goal: GoalSchema.nullable() }).strict(),
  'thread/goal/set': z.object({ goal: GoalSchema }).strict(),
  'thread/goal/clear': z.object({ goalId: OpaqueIdSchema }).strict(),
  'thread/plan/read': z.object({ plan: PlanSchema.nullable() }).strict(),
  'thread/plan/preview': z.object({ plan: PlanSchema }).strict(),
  'config/read': z
    .object({
      config: JsonValueSchema,
      sources: z
        .array(
          z
            .object({
              name: z.enum(['defaults', 'global', 'project', 'override']),
              path: z.string().nullable(),
              exists: z.boolean(),
              value: JsonValueSchema.optional(),
            })
            .strict(),
        )
        .readonly()
        .optional(),
    })
    .strict(),
  'config/write': z.object({ config: JsonValueSchema }).strict(),
  'config/init': z
    .object({ created: z.array(z.string().min(1)).readonly() })
    .strict(),
  'config/sources': z
    .object({
      data: z
        .array(
          z
            .object({
              name: z.enum(['defaults', 'global', 'project', 'override']),
              path: z.string().nullable(),
              exists: z.boolean(),
            })
            .strict(),
        )
        .readonly(),
    })
    .strict(),
  'model/list': CatalogResultSchema,
  'provider/list': CatalogResultSchema,
  'agent/list': CatalogResultSchema,
  'tool/list': CatalogResultSchema,
  'skills/list': CatalogResultSchema,
  'skills/get': z.object({ skill: CatalogEntrySchema }).strict(),
  'skills/reload': CatalogResultSchema,
  'memory/status': z
    .object({
      enabled: z.boolean(),
      state: z.enum(['idle', 'running', 'failed']),
      privateRoot: z.string().min(1),
      teamRoot: z.string().min(1),
      pendingJobs: NonNegativeIntegerSchema,
    })
    .strict(),
  'memory/reload': AckSchema,
  'memory/dream/start': z.object({ jobId: OpaqueIdSchema }).strict(),
  'task/list': TaskListResultSchema,
  'task/get': z.object({ task: TaskSchema }).strict(),
  'task/create': z.object({ task: TaskSchema }).strict(),
  'task/update': z.object({ task: TaskSchema }).strict(),
  'task/delete': AckSchema,
  'task/claim': z.object({ task: TaskSchema }).strict(),
  'task/reset': AckSchema,
  'fs/readFile': z
    .object({
      path: z.string().min(1),
      content: z.string(),
      byteCount: NonNegativeIntegerSchema,
      truncated: z.boolean(),
      artifactId: OpaqueIdSchema.optional(),
    })
    .strict(),
  'fs/readDirectory': z
    .object({ data: z.array(DirectoryEntrySchema).readonly() })
    .strict(),
  'fs/getMetadata': FileMetadataSchema,
  'fs/search': z
    .object({ data: z.array(DirectoryEntrySchema).readonly() })
    .strict(),
  'fs/watch': z.object({ watchId: OpaqueIdSchema }).strict(),
  'fs/unwatch': AckSchema,
  'repo/add': RepositoryOperationSchema,
  'repo/list': RepositoryListSchema,
  'repo/read': RepositoryOperationSchema,
  'repo/rename': RepositoryOperationSchema,
  'repo/remove': AckSchema,
  'repo/fetch': RepositoryOperationSchema,
  'repo/fetchLocal': RepositoryOperationSchema,
  'repo/remote/read': z.object({ remotes: JsonValueSchema }).strict(),
  'repo/remote/add': RepositoryOperationSchema,
  'repo/remote/set': RepositoryOperationSchema,
  'repo/remote/remove': RepositoryOperationSchema,
  'repo/export': z.object({ document: JsonValueSchema }).strict(),
  'repo/import': RepositoryListSchema,
  'workspace/create': WorkspaceOperationSchema,
  'workspace/list': WorkspaceListSchema,
  'workspace/archived/list': WorkspaceListSchema,
  'workspace/read': WorkspaceOperationSchema,
  'workspace/path': z.object({ path: z.string().min(1) }).strict(),
  'workspace/status': z.object({ status: JsonValueSchema }).strict(),
  'workspace/repo/add': WorkspaceOperationSchema,
  'workspace/repo/create': WorkspaceOperationSchema,
  'workspace/repo/remove': WorkspaceOperationSchema,
  'workspace/rename': WorkspaceOperationSchema,
  'workspace/archive': WorkspaceOperationSchema,
  'workspace/delete': AckSchema,
  'workspace/reconcile': z.object({ result: JsonValueSchema }).strict(),
  'workspace/repair': z.object({ result: JsonValueSchema }).strict(),
  'workspace/tmux/new': z.object({ session: z.string().min(1) }).strict(),
} as const satisfies Record<keyof typeof CLIENT_REQUEST_SCHEMAS, z.ZodType>;

export type ClientResult<M extends ClientMethod> = z.output<
  (typeof CLIENT_RESPONSE_SCHEMAS)[M]
>;

export function parseClientResult<M extends ClientMethod>(
  method: M,
  result: unknown,
): ClientResult<M> {
  return CLIENT_RESPONSE_SCHEMAS[method].parse(result) as ClientResult<M>;
}

export { EmptyResultSchema };
