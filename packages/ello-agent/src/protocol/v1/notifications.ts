import { z } from 'zod';

import {
  JsonValueSchema,
  NonNegativeIntegerSchema,
  OpaqueIdSchema,
  UsageSchema,
} from './common.js';
import {
  FileChangeSchema,
  GoalSchema,
  PlanSchema,
  ThreadItemSchema,
  ThreadSettingsSchema,
  ThreadStatusSchema,
  ThreadSummarySchema,
  TurnSchema,
} from './resources.js';

const ThreadSequenceShape = {
  threadId: OpaqueIdSchema,
  seq: NonNegativeIntegerSchema,
};
const TurnSequenceShape = {
  ...ThreadSequenceShape,
  turnId: OpaqueIdSchema,
};

export const CLIENT_NOTIFICATION_SCHEMAS = {
  initialized: z.object({}).strict(),
} as const;

/** Server 发出的 notification 只从此表验证，所有 thread 事件都显式携带 seq。 */
export const SERVER_NOTIFICATION_SCHEMAS = {
  'thread/sequence/advanced': z.object({ ...ThreadSequenceShape }).strict(),
  'thread/started': z
    .object({ ...ThreadSequenceShape, thread: ThreadSummarySchema })
    .strict(),
  'thread/status/changed': z
    .object({
      ...ThreadSequenceShape,
      status: ThreadStatusSchema,
      activeFlags: z.array(z.string().min(1)).readonly(),
    })
    .strict(),
  'thread/closed': z
    .object({ ...ThreadSequenceShape, reason: z.string().min(1) })
    .strict(),
  'thread/name/updated': z
    .object({ ...ThreadSequenceShape, name: z.string() })
    .strict(),
  'thread/settings/updated': z
    .object({ ...ThreadSequenceShape, settings: ThreadSettingsSchema })
    .strict(),
  'thread/goal/updated': z
    .object({ ...ThreadSequenceShape, goal: GoalSchema })
    .strict(),
  'thread/goal/cleared': z
    .object({ ...ThreadSequenceShape, goalId: OpaqueIdSchema })
    .strict(),
  'thread/tokenUsage/updated': z
    .object({ ...ThreadSequenceShape, usage: UsageSchema })
    .strict(),
  'thread/plan/updated': z
    .object({ ...ThreadSequenceShape, plan: PlanSchema.nullable() })
    .strict(),
  'thread/compaction/updated': z
    .object({
      ...ThreadSequenceShape,
      turnId: OpaqueIdSchema,
      summary: z.string(),
      firstKeptSeq: z.number().int().positive(),
      tokensBefore: NonNegativeIntegerSchema,
    })
    .strict(),
  'thread/archived': z.object({ ...ThreadSequenceShape }).strict(),
  'thread/unarchived': z
    .object({ ...ThreadSequenceShape, thread: ThreadSummarySchema })
    .strict(),
  'thread/deleted': z.object({ ...ThreadSequenceShape }).strict(),
  'turn/started': z.object({ ...TurnSequenceShape, turn: TurnSchema }).strict(),
  'turn/completed': z
    .object({ ...TurnSequenceShape, turn: TurnSchema })
    .strict(),
  'turn/diff/updated': z
    .object({
      ...TurnSequenceShape,
      changes: z.array(FileChangeSchema).readonly(),
    })
    .strict(),
  'item/started': z
    .object({
      ...TurnSequenceShape,
      itemId: OpaqueIdSchema,
      item: ThreadItemSchema,
    })
    .strict(),
  'item/completed': z
    .object({
      ...TurnSequenceShape,
      itemId: OpaqueIdSchema,
      item: ThreadItemSchema,
    })
    .strict(),
  'item/agentMessage/delta': z
    .object({
      ...TurnSequenceShape,
      itemId: OpaqueIdSchema,
      delta: z.string(),
    })
    .strict(),
  'item/plan/delta': z
    .object({
      ...TurnSequenceShape,
      itemId: OpaqueIdSchema,
      delta: z.string(),
    })
    .strict(),
  'item/commandExecution/outputDelta': z
    .object({
      ...TurnSequenceShape,
      itemId: OpaqueIdSchema,
      stream: z.enum(['stdout', 'stderr']),
      delta: z.string(),
    })
    .strict(),
  'serverRequest/resolved': z
    .object({
      ...TurnSequenceShape,
      itemId: OpaqueIdSchema,
      requestId: OpaqueIdSchema,
    })
    .strict(),
  'skills/changed': z
    .object({ cwd: z.string().min(1), paths: z.array(z.string()).readonly() })
    .strict(),
  'fs/changed': z
    .object({
      watchId: OpaqueIdSchema,
      path: z.string().min(1),
      event: z.enum(['rename', 'change']),
    })
    .strict(),
  'memory/job/updated': z
    .object({
      threadId: OpaqueIdSchema.optional(),
      jobId: OpaqueIdSchema,
      status: z.enum(['queued', 'running', 'completed', 'failed']),
      details: z.record(z.string(), JsonValueSchema).optional(),
    })
    .strict(),
  warning: z
    .object({
      code: z.string().min(1),
      message: z.string(),
      details: z.record(z.string(), JsonValueSchema).optional(),
    })
    .strict(),
  'server/ready': z.object({ protocolVersion: z.literal(1) }).strict(),
} as const;

export type ClientNotificationMethod = keyof typeof CLIENT_NOTIFICATION_SCHEMAS;
export type ClientNotificationParams<M extends ClientNotificationMethod> =
  z.input<(typeof CLIENT_NOTIFICATION_SCHEMAS)[M]>;
export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_SCHEMAS;
export type ServerNotificationParams<M extends ServerNotificationMethod> =
  z.output<(typeof SERVER_NOTIFICATION_SCHEMAS)[M]>;
export type ServerNotification = {
  [M in ServerNotificationMethod]: {
    readonly method: M;
    readonly params: ServerNotificationParams<M>;
  };
}[ServerNotificationMethod];

export function parseClientNotificationParams<
  M extends ClientNotificationMethod,
>(method: M, params: unknown): ClientNotificationParams<M> {
  return CLIENT_NOTIFICATION_SCHEMAS[method].parse(
    params,
  ) as ClientNotificationParams<M>;
}

export function parseServerNotificationParams<
  M extends ServerNotificationMethod,
>(method: M, params: unknown): ServerNotificationParams<M> {
  return SERVER_NOTIFICATION_SCHEMAS[method].parse(
    params,
  ) as ServerNotificationParams<M>;
}
