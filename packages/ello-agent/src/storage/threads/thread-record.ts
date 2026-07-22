/**
 * 本文件负责持久化层的“thread-record”模块职责。
 *
 * 文件、lease 或 record 状态由显式 store 入口拥有；读取结果在离开边界前完成结构校验。
 * 写入顺序、连续序号和资源释放是持久化不变量，损坏数据与非法状态直接失败。
 */
import { z } from 'zod';

import {
  GoalSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  NonNegativeIntegerSchema,
  OpaqueIdSchema,
  PendingServerRequestSchema,
  PlanSchema,
  ThreadItemSchema,
  ThreadSettingsSchema,
  ThreadStatusSchema,
  TurnSchema,
  UsageSchema,
} from '../../protocol/v1/index.js';

const RecordBaseShape = {
  schema: z.literal(1),
  seq: z.number().int().positive(),
  threadId: OpaqueIdSchema,
  createdAt: IsoDateTimeSchema,
};

export const ThreadCreatedRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('thread.created'),
    rootId: OpaqueIdSchema,
    forkedFromId: OpaqueIdSchema.optional(),
    cwd: z.string().min(1),
    name: z.string(),
    settings: ThreadSettingsSchema,
    metadata: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict();

export const ThreadMetadataRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('thread.metadata'),
    name: z.string().optional(),
    preview: z.string().optional(),
    archived: z.boolean().optional(),
    settings: ThreadSettingsSchema.optional(),
  })
  .strict();

export const ThreadStatusRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('thread.status'),
    status: ThreadStatusSchema,
    activeFlags: z.array(z.string().min(1)).readonly(),
  })
  .strict();

export const TurnStartedRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('turn.started'),
    turn: TurnSchema,
  })
  .strict();

export const TurnCompletedRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('turn.completed'),
    turn: TurnSchema,
  })
  .strict();

export const TurnInterruptedRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('turn.interrupted'),
    turn: TurnSchema,
    reason: z.string().min(1),
  })
  .strict();

export const TurnFailedRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('turn.failed'),
    turn: TurnSchema,
    error: z.object({ code: z.string().min(1), message: z.string() }).strict(),
  })
  .strict();

export const ItemStartedRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('item.started'),
    turnId: OpaqueIdSchema,
    item: ThreadItemSchema,
  })
  .strict();

export const ItemDeltaRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('item.delta'),
    turnId: OpaqueIdSchema,
    itemId: OpaqueIdSchema,
    delta: z.discriminatedUnion('type', [
      z.object({ type: z.literal('agentMessage'), text: z.string() }).strict(),
      z.object({ type: z.literal('plan'), text: z.string() }).strict(),
      z
        .object({
          type: z.literal('commandOutput'),
          stream: z.enum(['stdout', 'stderr']),
          text: z.string(),
        })
        .strict(),
    ]),
  })
  .strict();

export const ItemCompletedRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('item.completed'),
    turnId: OpaqueIdSchema,
    item: ThreadItemSchema,
  })
  .strict();

export const TranscriptEntryRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('transcript.entry'),
    turnId: OpaqueIdSchema,
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    message: JsonValueSchema,
  })
  .strict();

export const CompactionRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('compaction'),
    turnId: OpaqueIdSchema,
    summary: z.string(),
    firstKeptSeq: z.number().int().positive(),
    tokensBefore: NonNegativeIntegerSchema,
  })
  .strict();

export const GoalStateRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('goal.state'),
    goal: GoalSchema.nullable(),
    goalId: OpaqueIdSchema.optional(),
  })
  .strict();

export const PlanStateRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('plan.state'),
    plan: PlanSchema.nullable(),
  })
  .strict();

export const ContentReplacementRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('content.replacement'),
    toolCallId: OpaqueIdSchema,
    artifactId: OpaqueIdSchema,
    preview: z.string(),
    originalBytes: NonNegativeIntegerSchema,
    sha256: z.string().regex(/^[a-f\d]{64}$/u),
  })
  .strict();

export const ServerRequestRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('serverRequest.created'),
    request: PendingServerRequestSchema,
  })
  .strict();

export const ServerRequestResolvedRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('serverRequest.resolved'),
    requestId: OpaqueIdSchema,
    turnId: OpaqueIdSchema,
    itemId: OpaqueIdSchema,
    resolution: z.enum(['resolved', 'rejected', 'cancelledByRestart']),
  })
  .strict();

export const UsageRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal('usage.updated'),
    usage: UsageSchema,
  })
  .strict();

export const ThreadRecordSchema = z.discriminatedUnion('kind', [
  ThreadCreatedRecordSchema,
  ThreadMetadataRecordSchema,
  ThreadStatusRecordSchema,
  TurnStartedRecordSchema,
  TurnCompletedRecordSchema,
  TurnInterruptedRecordSchema,
  TurnFailedRecordSchema,
  ItemStartedRecordSchema,
  ItemDeltaRecordSchema,
  ItemCompletedRecordSchema,
  TranscriptEntryRecordSchema,
  CompactionRecordSchema,
  GoalStateRecordSchema,
  PlanStateRecordSchema,
  ContentReplacementRecordSchema,
  ServerRequestRecordSchema,
  ServerRequestResolvedRecordSchema,
  UsageRecordSchema,
]);

export type ThreadRecord = z.infer<typeof ThreadRecordSchema>;
export type ThreadRecordKind = ThreadRecord['kind'];
export type NewThreadRecord = ThreadRecord extends infer RecordType
  ? RecordType extends ThreadRecord
    ? Omit<RecordType, 'schema' | 'seq' | 'threadId' | 'createdAt'>
    : never
  : never;

/**
 * 校验 持久化层的 `thread-record` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `value`: 要由 `parseThreadRecord` 读取或写入的单个领域值；所有权仍归调用方。
 * - `source`: `parseThreadRecord` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `parseThreadRecord` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 持久化层的 `thread-record` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function parseThreadRecord(
  value: unknown,
  source: string,
): ThreadRecord {
  const parsed = ThreadRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid thread record at ${source}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
