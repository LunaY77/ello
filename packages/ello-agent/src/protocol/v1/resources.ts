/**
 * 本文件负责 Protocol 的“resources”模块职责。
 *
 * 模块不持有可变运行状态；wire 数据以 unknown 进入并由 schema 或显式 parser 收窄。
 * 字段名称、判别值和错误语义属于跨进程协议，调用方不得绕过校验直接构造不完整值。
 */
import { z } from 'zod';

import {
  IsoDateTimeSchema,
  JsonValueSchema,
  NonNegativeIntegerSchema,
  OpaqueIdSchema,
  SessionModeSchema,
  UsageSchema,
} from './common.js';

export const ThreadStatusSchema = z.enum([
  'idle',
  'running',
  'awaitingApproval',
  'awaitingUserInput',
  'interrupted',
  'failed',
]);

export const TurnStatusSchema = z.enum([
  'inProgress',
  'completed',
  'interrupted',
  'failed',
]);

const ItemStatusSchema = z.enum([
  'inProgress',
  'completed',
  'failed',
  'declined',
]);

export const FileChangeSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(['add', 'modify', 'delete', 'rename']),
    oldPath: z.string().min(1).optional(),
    additions: NonNegativeIntegerSchema.optional(),
    deletions: NonNegativeIntegerSchema.optional(),
    diff: z.string().optional(),
  })
  .strict();

const ItemBaseShape = {
  id: OpaqueIdSchema,
  turnId: OpaqueIdSchema,
  createdAt: IsoDateTimeSchema,
};

export const UserMessageItemSchema = z
  .object({
    ...ItemBaseShape,
    type: z.literal('userMessage'),
    text: z.string(),
  })
  .strict();

export const AgentMessageItemSchema = z
  .object({
    ...ItemBaseShape,
    type: z.literal('agentMessage'),
    text: z.string(),
    phase: z.enum(['commentary', 'final']),
    status: ItemStatusSchema,
  })
  .strict();

export const ReasoningItemSchema = z
  .object({
    ...ItemBaseShape,
    type: z.literal('reasoning'),
    summary: z.string(),
    status: ItemStatusSchema,
  })
  .strict();

export const PlanItemSchema = z
  .object({
    ...ItemBaseShape,
    type: z.literal('plan'),
    text: z.string(),
    contentHash: z.string().min(1).optional(),
    status: ItemStatusSchema,
  })
  .strict();

export const CommandExecutionItemSchema = z
  .object({
    ...ItemBaseShape,
    type: z.literal('commandExecution'),
    command: z.string(),
    cwd: z.string().min(1),
    status: ItemStatusSchema,
    outputPreview: z.string().optional(),
    artifactId: OpaqueIdSchema.optional(),
    outputBytes: NonNegativeIntegerSchema.optional(),
    exitCode: z.number().int().optional(),
    durationMs: NonNegativeIntegerSchema.optional(),
  })
  .strict();

export const FileChangeItemSchema = z
  .object({
    ...ItemBaseShape,
    type: z.literal('fileChange'),
    changes: z.array(FileChangeSchema).readonly(),
    status: ItemStatusSchema,
  })
  .strict();

export const ToolCallItemSchema = z
  .object({
    ...ItemBaseShape,
    type: z.literal('toolCall'),
    toolName: z.string().min(1),
    headline: z.string(),
    status: ItemStatusSchema,
    outputPreview: z.string().optional(),
    artifactId: OpaqueIdSchema.optional(),
    metadata: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();

export const SubagentItemSchema = z
  .object({
    ...ItemBaseShape,
    type: z.literal('subagent'),
    agentName: z.string().min(1),
    description: z.string(),
    background: z.boolean(),
    status: ItemStatusSchema,
    output: z.string().optional(),
  })
  .strict();

export const ContextCompactionItemSchema = z
  .object({
    ...ItemBaseShape,
    type: z.literal('contextCompaction'),
    summary: z.string(),
    tokensBefore: NonNegativeIntegerSchema,
    status: ItemStatusSchema,
  })
  .strict();

export const NoticeItemSchema = z
  .object({
    ...ItemBaseShape,
    type: z.literal('notice'),
    level: z.enum(['info', 'warning']),
    message: z.string(),
  })
  .strict();

export const ErrorItemSchema = z
  .object({
    ...ItemBaseShape,
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();

export const ThreadItemSchema = z.discriminatedUnion('type', [
  UserMessageItemSchema,
  AgentMessageItemSchema,
  ReasoningItemSchema,
  PlanItemSchema,
  CommandExecutionItemSchema,
  FileChangeItemSchema,
  ToolCallItemSchema,
  SubagentItemSchema,
  ContextCompactionItemSchema,
  NoticeItemSchema,
  ErrorItemSchema,
]);

export const TurnSchema = z
  .object({
    id: OpaqueIdSchema,
    threadId: OpaqueIdSchema,
    status: TurnStatusSchema,
    items: z.array(ThreadItemSchema).readonly(),
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.optional(),
    errorCode: z.string().min(1).optional(),
    usage: UsageSchema.optional(),
  })
  .strict();

export const ThreadSummarySchema = z
  .object({
    id: OpaqueIdSchema,
    rootId: OpaqueIdSchema,
    forkedFromId: OpaqueIdSchema.optional(),
    cwd: z.string().min(1),
    name: z.string(),
    preview: z.string(),
    status: ThreadStatusSchema,
    archived: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const PendingServerRequestSchema = z
  .object({
    id: OpaqueIdSchema,
    method: z.string().min(1),
    threadId: OpaqueIdSchema,
    turnId: OpaqueIdSchema,
    itemId: OpaqueIdSchema,
    params: z.record(z.string(), JsonValueSchema),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const GoalSchema = z
  .object({
    id: OpaqueIdSchema,
    objective: z.string().min(1).max(4_000),
    status: z.enum(['active', 'paused', 'blocked', 'complete']),
    tokenBudget: NonNegativeIntegerSchema.optional(),
    tokensUsed: NonNegativeIntegerSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const PlanSchema = z
  .object({
    threadId: OpaqueIdSchema,
    status: z.enum(['draft', 'awaitingApproval', 'accepted', 'rejected']),
    contentHash: z.string().min(1),
    content: z.string(),
    path: z.string().min(1),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const ThreadSettingsSchema = z
  .object({
    mode: SessionModeSchema,
    profile: z.string().min(1),
    model: z.string().min(1),
    agent: z.string().min(1),
  })
  .strict();

export const ThreadSnapshotSchema = z
  .object({
    thread: ThreadSummarySchema,
    settings: ThreadSettingsSchema,
    turns: z.array(TurnSchema).readonly(),
    pendingServerRequests: z.array(PendingServerRequestSchema).readonly(),
    goal: GoalSchema.nullable(),
    plan: PlanSchema.nullable(),
    usage: UsageSchema,
    seq: NonNegativeIntegerSchema,
  })
  .strict();

export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;
export type TurnStatus = z.infer<typeof TurnStatusSchema>;
export type FileChange = z.infer<typeof FileChangeSchema>;
export type ThreadItem = z.infer<typeof ThreadItemSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
export type ThreadSnapshot = z.infer<typeof ThreadSnapshotSchema>;
export type PendingServerRequest = z.infer<typeof PendingServerRequestSchema>;
export type Goal = z.infer<typeof GoalSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type ThreadSettings = z.infer<typeof ThreadSettingsSchema>;
