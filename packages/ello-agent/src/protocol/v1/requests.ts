import { z } from 'zod';

import {
  EmptyParamsSchema,
  JsonValueSchema,
  OpaqueIdSchema,
  PaginationParamsSchema,
  ProtocolVersionSchema,
  SessionModeSchema,
  UserInputSchema,
} from './common.js';

const ThreadIdParamsSchema = z.object({ threadId: OpaqueIdSchema }).strict();
const NamedIdParamsSchema = z.object({ id: OpaqueIdSchema }).strict();
const CwdParamsSchema = z.object({ cwd: z.string().min(1) }).strict();
const OptionalThreadParamsSchema = z
  .object({ threadId: OpaqueIdSchema.optional(), cwd: z.string().min(1) })
  .strict();

export const InitializeParamsSchema = z
  .object({
    clientInfo: z
      .object({
        name: z.string().min(1),
        title: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
    protocolVersion: ProtocolVersionSchema,
    capabilities: z
      .object({
        experimentalApi: z.boolean(),
        supportsServerRequests: z.boolean(),
        supportsUserInput: z.boolean(),
        optOutNotificationMethods: z.array(z.string().min(1)).readonly(),
        platform: z.enum(['terminal', 'desktop', 'mobile', 'automation']),
      })
      .strict(),
  })
  .strict();

export const ThreadStartParamsSchema = z
  .object({
    cwd: z.string().min(1),
    name: z.string().optional(),
    profile: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    mode: SessionModeSchema.optional(),
    agent: z.string().min(1).optional(),
    subscribe: z.boolean().default(true),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const ThreadResumeParamsSchema = z
  .object({ threadId: OpaqueIdSchema, subscribe: z.boolean().default(true) })
  .strict();

export const ThreadReadParamsSchema = z
  .object({
    threadId: OpaqueIdSchema,
    includeTurns: z.boolean().default(true),
    includeItems: z.boolean().default(true),
  })
  .strict();

export const ThreadListParamsSchema = PaginationParamsSchema.extend({
  cwd: z.string().min(1).optional(),
  archived: z.boolean().default(false),
}).strict();

export const ThreadForkParamsSchema = z
  .object({
    threadId: OpaqueIdSchema,
    lastTurnId: OpaqueIdSchema.optional(),
    name: z.string().optional(),
    subscribe: z.boolean().default(true),
  })
  .strict();

export const TurnStartParamsSchema = z
  .object({
    threadId: OpaqueIdSchema,
    input: z.array(UserInputSchema).min(1).readonly(),
    model: z.string().min(1).optional(),
    profile: z.string().min(1).optional(),
    mode: SessionModeSchema.optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const TurnSteerParamsSchema = z
  .object({
    threadId: OpaqueIdSchema,
    expectedTurnId: OpaqueIdSchema,
    input: z.array(UserInputSchema).min(1).readonly(),
  })
  .strict();

export const TurnInterruptParamsSchema = z
  .object({
    threadId: OpaqueIdSchema,
    turnId: OpaqueIdSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();

const ThreadHistoryParamsSchema = PaginationParamsSchema.extend({
  threadId: OpaqueIdSchema,
}).strict();

const ConfigReadParamsSchema = z
  .object({
    cwd: z.string().min(1),
    includeSources: z.boolean().default(false),
  })
  .strict();

const ConfigWriteParamsSchema = z
  .object({
    cwd: z.string().min(1),
    source: z.enum(['global', 'project']),
    path: z.array(z.string().min(1)).min(1).readonly(),
    value: JsonValueSchema.optional(),
    operation: z.enum(['set', 'delete']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === 'set' && value.value === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'config/write set requires value.',
        path: ['value'],
      });
    }
    if (value.operation === 'delete' && value.value !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'config/write delete must not include value.',
        path: ['value'],
      });
    }
  });

const TaskListParamsSchema = PaginationParamsSchema.extend({
  boardId: z.string().min(1).optional(),
  status: z
    .enum(['pending', 'inProgress', 'completed', 'cancelled'])
    .optional(),
}).strict();

const RepoIdentifierParamsSchema = z
  .object({ repo: z.string().min(1) })
  .strict();
const WorkspaceIdentifierParamsSchema = z
  .object({ workspace: z.string().min(1) })
  .strict();

/**
 * 每个 method 都有独立 strict schema。Server 和 Client 只能从这里解析 params，
 * 不能在 handler 内再维护一套宽松参数约定。
 */
export const CLIENT_REQUEST_SCHEMAS = {
  initialize: InitializeParamsSchema,
  'server/read': EmptyParamsSchema,
  'server/shutdown': z
    .object({ reason: z.string().min(1).optional() })
    .strict(),
  'thread/start': ThreadStartParamsSchema,
  'thread/resume': ThreadResumeParamsSchema,
  'thread/read': ThreadReadParamsSchema,
  'thread/list': ThreadListParamsSchema,
  'thread/loaded/list': EmptyParamsSchema,
  'thread/fork': ThreadForkParamsSchema,
  'thread/unsubscribe': ThreadIdParamsSchema,
  'thread/archive': ThreadIdParamsSchema,
  'thread/unarchive': ThreadIdParamsSchema,
  'thread/delete': ThreadIdParamsSchema,
  'thread/turns/list': ThreadHistoryParamsSchema,
  'thread/items/list': ThreadHistoryParamsSchema.extend({
    turnId: OpaqueIdSchema.optional(),
  }).strict(),
  'thread/export': z
    .object({
      threadId: OpaqueIdSchema,
      format: z.enum(['jsonl', 'html', 'markdown']),
    })
    .strict(),
  'artifact/read': z
    .object({
      artifactId: OpaqueIdSchema,
      offset: z.number().int().nonnegative().default(0),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(1024 * 1024)
        .default(256 * 1024),
    })
    .strict(),
  'thread/compact/start': ThreadIdParamsSchema,
  'thread/shellCommand': z
    .object({
      threadId: OpaqueIdSchema,
      command: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  'thread/settings/update': z
    .object({
      threadId: OpaqueIdSchema,
      mode: SessionModeSchema.optional(),
      profile: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      agent: z.string().min(1).optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.mode !== undefined ||
        value.profile !== undefined ||
        value.model !== undefined ||
        value.agent !== undefined,
      'At least one setting is required.',
    ),
  'turn/start': TurnStartParamsSchema,
  'turn/steer': TurnSteerParamsSchema,
  'turn/interrupt': TurnInterruptParamsSchema,
  'thread/goal/get': ThreadIdParamsSchema,
  'thread/goal/set': z
    .object({
      threadId: OpaqueIdSchema,
      objective: z.string().trim().min(1).max(4_000),
      tokenBudget: z.number().int().positive().optional(),
      status: z.enum(['active', 'paused', 'blocked', 'complete']).optional(),
    })
    .strict(),
  'thread/goal/clear': ThreadIdParamsSchema,
  'thread/plan/read': ThreadIdParamsSchema,
  'thread/plan/preview': z
    .object({ threadId: OpaqueIdSchema, contentHash: z.string().min(1) })
    .strict(),
  'config/read': ConfigReadParamsSchema,
  'config/settings': CwdParamsSchema,
  'config/write': ConfigWriteParamsSchema,
  'config/init': z
    .object({ cwd: z.string().min(1), force: z.boolean().default(false) })
    .strict(),
  'config/sources': CwdParamsSchema,
  'model/list': CwdParamsSchema,
  'provider/list': CwdParamsSchema,
  'agent/list': OptionalThreadParamsSchema,
  'tool/list': OptionalThreadParamsSchema,
  'skills/list': OptionalThreadParamsSchema.extend({
    query: z.string().optional(),
  }).strict(),
  'skills/get': OptionalThreadParamsSchema.extend({
    name: z.string().min(1),
  }).strict(),
  'skills/reload': OptionalThreadParamsSchema,
  'memory/status': OptionalThreadParamsSchema,
  'memory/reload': OptionalThreadParamsSchema,
  'memory/dream/start': OptionalThreadParamsSchema,
  'task/list': TaskListParamsSchema,
  'task/get': NamedIdParamsSchema,
  'task/create': z
    .object({
      boardId: z.string().min(1),
      subject: z.string().min(1),
      description: z.string(),
      activeForm: z.string().optional(),
      owner: z.string().min(1).optional(),
      blockedBy: z.array(OpaqueIdSchema).default([]).readonly(),
      metadata: z.record(z.string(), JsonValueSchema).default({}),
    })
    .strict(),
  'task/update': z
    .object({
      id: OpaqueIdSchema,
      subject: z.string().min(1).optional(),
      description: z.string().optional(),
      activeForm: z.string().optional(),
      status: z
        .enum(['pending', 'inProgress', 'completed', 'cancelled'])
        .optional(),
      owner: z.string().min(1).nullable().optional(),
      addBlockedBy: z.array(OpaqueIdSchema).optional(),
      removeBlockedBy: z.array(OpaqueIdSchema).optional(),
      metadata: z.record(z.string(), JsonValueSchema).optional(),
    })
    .strict(),
  'task/delete': NamedIdParamsSchema,
  'task/claim': z
    .object({ id: OpaqueIdSchema, owner: z.string().min(1) })
    .strict(),
  'task/reset': z
    .object({ boardId: z.string().min(1), force: z.boolean() })
    .strict(),
  'fs/readFile': z
    .object({
      cwd: z.string().min(1),
      path: z.string().min(1),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024)
        .optional(),
    })
    .strict(),
  'fs/readDirectory': z
    .object({ cwd: z.string().min(1), path: z.string().min(1) })
    .strict(),
  'fs/getMetadata': z
    .object({ cwd: z.string().min(1), path: z.string().min(1) })
    .strict(),
  'fs/search': z
    .object({
      cwd: z.string().min(1),
      query: z.string(),
      kind: z.enum(['file', 'directory', 'any']).default('any'),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  'fs/watch': z
    .object({ cwd: z.string().min(1), paths: z.array(z.string()).min(1) })
    .strict(),
  'fs/unwatch': z.object({ watchId: OpaqueIdSchema }).strict(),
  'repo/add': z
    .object({
      key: z.string().min(1),
      source: z.string().min(1),
      remoteUrl: z.string().min(1).optional(),
    })
    .strict(),
  'repo/list': EmptyParamsSchema,
  'repo/read': RepoIdentifierParamsSchema,
  'repo/rename': RepoIdentifierParamsSchema.extend({
    name: z.string().min(1),
  }).strict(),
  'repo/remove': RepoIdentifierParamsSchema,
  'repo/fetch': RepoIdentifierParamsSchema,
  'repo/fetchLocal': RepoIdentifierParamsSchema.extend({
    path: z.string().min(1),
  }).strict(),
  'repo/remote/read': RepoIdentifierParamsSchema,
  'repo/remote/add': RepoIdentifierParamsSchema.extend({
    name: z.string().min(1),
    url: z.string().min(1),
  }).strict(),
  'repo/remote/set': RepoIdentifierParamsSchema.extend({
    name: z.string().min(1),
    url: z.string().min(1),
  }).strict(),
  'repo/remote/remove': RepoIdentifierParamsSchema.extend({
    name: z.string().min(1),
  }).strict(),
  'repo/export': z
    .object({ repos: z.array(z.string().min(1)).optional() })
    .strict(),
  'repo/import': z.object({ document: JsonValueSchema }).strict(),
  'workspace/create': z
    .object({
      kind: z.enum(['feature', 'fix', 'refactor', 'explore']),
      name: z.string().min(1),
      repos: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  'workspace/list': EmptyParamsSchema,
  'workspace/archived/list': EmptyParamsSchema,
  'workspace/read': WorkspaceIdentifierParamsSchema,
  'workspace/path': WorkspaceIdentifierParamsSchema,
  'workspace/status': WorkspaceIdentifierParamsSchema,
  'workspace/repo/add': WorkspaceIdentifierParamsSchema.extend({
    repo: z.string().min(1),
    role: z.enum(['development', 'reference']).default('development'),
    detached: z.boolean().default(false),
  }).strict(),
  'workspace/repo/create': WorkspaceIdentifierParamsSchema.extend({
    key: z.string().min(1),
  }).strict(),
  'workspace/repo/remove': WorkspaceIdentifierParamsSchema.extend({
    repo: z.string().min(1),
  }).strict(),
  'workspace/rename': WorkspaceIdentifierParamsSchema.extend({
    name: z.string().min(1),
  }).strict(),
  'workspace/archive': WorkspaceIdentifierParamsSchema,
  'workspace/delete': WorkspaceIdentifierParamsSchema.extend({
    force: z.boolean().default(false),
  }).strict(),
  'workspace/reconcile': WorkspaceIdentifierParamsSchema,
  'workspace/repair': WorkspaceIdentifierParamsSchema,
  'workspace/tmux/new': WorkspaceIdentifierParamsSchema.extend({
    command: z.string().min(1).optional(),
  }).strict(),
} as const;

export type ClientMethod = keyof typeof CLIENT_REQUEST_SCHEMAS;
export type ClientParams<M extends ClientMethod> = z.input<
  (typeof CLIENT_REQUEST_SCHEMAS)[M]
>;
export type ParsedClientParams<M extends ClientMethod> = z.output<
  (typeof CLIENT_REQUEST_SCHEMAS)[M]
>;

export function parseClientParams<M extends ClientMethod>(
  method: M,
  params: unknown,
): ParsedClientParams<M> {
  return CLIENT_REQUEST_SCHEMAS[method].parse(params) as ParsedClientParams<M>;
}
