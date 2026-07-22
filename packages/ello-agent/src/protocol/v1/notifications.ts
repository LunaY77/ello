/**
 * 本文件负责 Protocol 的通知投影。
 *
 * 模块不持有可变运行状态；wire 数据以 unknown 进入并由 schema 或显式 parser 收窄。
 * 字段名称、判别值和错误语义属于跨进程协议，调用方不得绕过校验直接构造不完整值。
 */
import { z } from 'zod';

import {
  JsonValueSchema,
  NonNegativeIntegerSchema,
  OpaqueIdSchema,
  parseSchemaMap,
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
  z.output<(typeof CLIENT_NOTIFICATION_SCHEMAS)[M]>;
export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_SCHEMAS;
export type ServerNotificationParams<M extends ServerNotificationMethod> =
  z.output<(typeof SERVER_NOTIFICATION_SCHEMAS)[M]>;
export type ServerNotification = {
  [M in ServerNotificationMethod]: {
    readonly method: M;
    readonly params: ServerNotificationParams<M>;
  };
}[ServerNotificationMethod];

/**
 * 校验 JSON-RPC 协议的 `notifications` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `method`: `parseClientNotificationParams` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `params`: `parseClientNotificationParams` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `parseClientNotificationParams` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 JSON-RPC 协议的 `notifications` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function parseClientNotificationParams<
  M extends ClientNotificationMethod,
>(method: M, params: unknown): ClientNotificationParams<M> {
  return parseSchemaMap(CLIENT_NOTIFICATION_SCHEMAS, method, params);
}

/**
 * 校验 JSON-RPC 协议的 `notifications` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `method`: `parseServerNotificationParams` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `params`: `parseServerNotificationParams` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `parseServerNotificationParams` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 JSON-RPC 协议的 `notifications` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function parseServerNotificationParams<
  M extends ServerNotificationMethod,
>(method: M, params: unknown): ServerNotificationParams<M> {
  return parseSchemaMap(SERVER_NOTIFICATION_SCHEMAS, method, params);
}
