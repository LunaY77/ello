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
  'archived',
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
    steerId: OpaqueIdSchema.optional(),
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
    error: z.string().min(1).optional(),
    outputPreview: z.string().optional(),
    artifactId: OpaqueIdSchema.optional(),
    metadata: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();

export const CommandRunCommandSchema = z
  .object({
    commandId: OpaqueIdSchema,
    index: NonNegativeIntegerSchema,
    step: z.number().int().positive(),
    name: z.string().min(1),
    input: JsonValueSchema,
    inputDigest: z.string().regex(/^[a-f\d]{64}$/u),
    status: z.enum([
      'pending',
      'running',
      'completed',
      'failed',
      'denied',
      'blocked',
      'deferred',
      'interrupted',
    ]),
    output: JsonValueSchema.optional(),
    error: z.string().min(1).optional(),
    blockedBy: OpaqueIdSchema.optional(),
    startedAt: IsoDateTimeSchema.optional(),
    completedAt: IsoDateTimeSchema.optional(),
    metadata: z.record(z.string(), JsonValueSchema).optional(),
    approval: z
      .object({
        status: z.enum(['required', 'approved', 'denied']),
        reason: z.string().optional(),
        metadata: z.record(z.string(), JsonValueSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const CommandRunCheckpointSchema = z
  .object({
    schema: z.literal(1),
    commandRunId: OpaqueIdSchema,
    providerToolCallId: OpaqueIdSchema,
    inputDigest: z.string().regex(/^[a-f\d]{64}$/u),
    catalogRevision: z.string().regex(/^[a-f\d]{64}$/u),
    compiledFrames: z
      .array(
        z
          .object({
            index: NonNegativeIntegerSchema,
            step: z.number().int().positive(),
            command: z.string().min(1),
            input: JsonValueSchema,
            inputDigest: z.string().regex(/^[a-f\d]{64}$/u),
            commandId: OpaqueIdSchema,
            onFailure: z.enum(['stop', 'diagnose', 'continue']),
          })
          .strict(),
      )
      .readonly(),
    results: z
      .array(
        z
          .object({
            commandRunId: OpaqueIdSchema,
            commandId: OpaqueIdSchema,
            index: NonNegativeIntegerSchema,
            step: z.number().int().positive(),
            name: z.string().min(1),
            input: JsonValueSchema,
            inputDigest: z.string().regex(/^[a-f\d]{64}$/u),
            status: z.enum([
              'pending',
              'running',
              'completed',
              'failed',
              'denied',
              'blocked',
              'deferred',
              'interrupted',
            ]),
            output: JsonValueSchema.optional(),
            error: z.string().min(1).optional(),
            blockedBy: OpaqueIdSchema.optional(),
            startedAt: IsoDateTimeSchema.optional(),
            completedAt: IsoDateTimeSchema.optional(),
            metadata: z.record(z.string(), JsonValueSchema).optional(),
            approval: z
              .object({
                status: z.enum(['approved', 'denied']),
                reason: z.string().optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .readonly(),
    phaseCursor: NonNegativeIntegerSchema,
    barrier: z
      .object({
        step: z.number().int().positive(),
        commandId: OpaqueIdSchema,
        commandName: z.string().min(1),
        status: z.enum(['failed', 'denied']),
      })
      .strict()
      .optional(),
    approvals: z
      .array(
        z
          .object({
            commandId: OpaqueIdSchema,
            command: z.string().min(1),
            inputDigest: z.string().regex(/^[a-f\d]{64}$/u),
            catalogRevision: z.string().regex(/^[a-f\d]{64}$/u),
            decision: z.enum(['approved', 'denied']),
            reason: z.string().optional(),
          })
          .strict(),
      )
      .readonly(),
    pendingCommandIds: z.array(OpaqueIdSchema).readonly(),
    pendingKind: z.enum(['approval', 'deferred']),
  })
  .strict();

export const CommandRunItemSchema = z
  .object({
    ...ItemBaseShape,
    type: z.literal('commandRun'),
    providerToolCallId: OpaqueIdSchema,
    status: z.enum([
      'inProgress',
      'completed',
      'failed',
      'denied',
      'interrupted',
    ]),
    commands: z.array(CommandRunCommandSchema).readonly(),
    checkpoint: CommandRunCheckpointSchema.optional(),
    error: z.string().min(1).optional(),
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
    beforeMessageCount: NonNegativeIntegerSchema.optional(),
    afterMessageCount: NonNegativeIntegerSchema.optional(),
    keptMessageCount: NonNegativeIntegerSchema.optional(),
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
  CommandRunItemSchema,
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
    commandId: OpaqueIdSchema.optional(),
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

export const AgentTaskStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'killed',
  'recovered',
]);

export const AgentTaskToolSummarySchema = z
  .object({
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    invocationPreview: z.string(),
    status: z.enum(['running', 'completed', 'failed']),
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.optional(),
  })
  .strict();

/** Composer 下 Agent switcher 使用的稳定任务摘要。 */
export const AgentTaskSummarySchema = z
  .object({
    taskId: OpaqueIdSchema,
    agentId: OpaqueIdSchema,
    rootThreadId: OpaqueIdSchema,
    parentTaskId: OpaqueIdSchema.optional(),
    resumeFromTaskId: OpaqueIdSchema.optional(),
    name: z.string().min(1).optional(),
    definitionName: z.string().min(1),
    description: z.string().min(1),
    contextMode: z.enum(['fresh', 'fork']),
    executionMode: z.enum(['foreground', 'background']),
    status: AgentTaskStatusSchema,
    cwd: z.string().min(1),
    isolation: z.enum(['shared', 'worktree', 'container']),
    revision: NonNegativeIntegerSchema,
    eventSequence: NonNegativeIntegerSchema,
    usage: UsageSchema.optional(),
    currentTool: z
      .object({
        toolCallId: z.string().min(1),
        name: z.string().min(1),
        startedAt: IsoDateTimeSchema,
      })
      .strict()
      .optional(),
    toolCount: NonNegativeIntegerSchema,
    recentTools: z.array(AgentTaskToolSummarySchema).max(4).readonly(),
    resultPreview: z.string().max(480).optional(),
    errorPreview: z.string().max(480).optional(),
    createdAt: IsoDateTimeSchema,
    startedAt: IsoDateTimeSchema.optional(),
    completedAt: IsoDateTimeSchema.optional(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

/** 子代理 transcript 的持久事件。payload 必须是闭合 JSON 值。 */
export const AgentTaskEventSchema = z
  .object({
    rootThreadId: OpaqueIdSchema,
    taskId: OpaqueIdSchema,
    sequence: z.number().int().positive(),
    rootSequence: z.number().int().positive(),
    eventType: z.string().min(1),
    payload: JsonValueSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const AgentTaskTreeSnapshotSchema = z
  .object({
    rootThreadId: OpaqueIdSchema,
    seq: NonNegativeIntegerSchema,
    tasks: z.array(AgentTaskSummarySchema).readonly(),
  })
  .strict();

export const AgentTaskDetailSchema = z
  .object({
    task: AgentTaskSummarySchema,
    prompt: z.string(),
    output: z.string().optional(),
    error: z.string().optional(),
    events: z.array(AgentTaskEventSchema).readonly(),
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
export type AgentTaskStatus = z.infer<typeof AgentTaskStatusSchema>;
export type AgentTaskToolSummary = z.infer<typeof AgentTaskToolSummarySchema>;
export type AgentTaskSummary = z.infer<typeof AgentTaskSummarySchema>;
export type AgentTaskEvent = z.infer<typeof AgentTaskEventSchema>;
export type AgentTaskTreeSnapshot = z.infer<typeof AgentTaskTreeSnapshotSchema>;
export type AgentTaskDetail = z.infer<typeof AgentTaskDetailSchema>;
