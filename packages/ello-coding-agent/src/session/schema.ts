import type { AgentMessage } from '@ello/agent';
import { z } from 'zod';

import {
  GoalClearedRecordSchema,
  GoalSessionRecordSchema,
} from '../goal/schema.js';
import { SessionModeSchema } from '../runtime/session-mode.js';

import type { SessionRecord } from './repository.js';

const Message = z.custom<AgentMessage>((value) => {
  if (typeof value !== 'object' || value === null || !('role' in value)) {
    return false;
  }
  const role = (value as { readonly role: unknown }).role;
  return ['system', 'user', 'assistant', 'tool'].includes(String(role));
});
const Usage = z
  .object({
    requests: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    toolCalls: z.number(),
  })
  .strict();
const CreatedAt = { createdAt: z.string() };

const HeaderRecordSchema = z
  .object({
    kind: z.literal('header'),
    sessionId: z.string(),
    cwd: z.string(),
    createdAt: z.string(),
    version: z.literal(3),
  })
  .strict();
const EntryRecordSchema = z
  .object({
    kind: z.literal('entry'),
    id: z.string(),
    parentId: z.string().nullable(),
    type: z.literal('message'),
    message: Message,
    ...CreatedAt,
  })
  .strict();
const LeafRecordSchema = z
  .object({
    kind: z.literal('leaf'),
    entryId: z.string().nullable(),
    ...CreatedAt,
  })
  .strict();
const BranchRecordSchema = z
  .object({
    kind: z.literal('branch'),
    from: z.string().nullable(),
    to: z.string(),
    reason: z.string(),
    ...CreatedAt,
  })
  .strict();
const TitleRecordSchema = z
  .object({ kind: z.literal('session-title'), title: z.string(), ...CreatedAt })
  .strict();
const CompactionRecordSchema = z
  .object({
    kind: z.literal('compaction'),
    id: z.string(),
    parentId: z.string().nullable(),
    firstKeptEntryId: z.string(),
    summary: z.string(),
    tokensBefore: z.number(),
    details: z
      .object({
        readFiles: z.array(z.string()).optional(),
        modifiedFiles: z.array(z.string()).optional(),
      })
      .optional(),
    ...CreatedAt,
  })
  .strict();
const ReplacementRecordSchema = z
  .object({
    kind: z.literal('content-replacement'),
    toolCallId: z.string(),
    artifactId: z.string(),
    preview: z.string(),
    originalBytes: z.number(),
    sha256: z.string(),
    ...CreatedAt,
  })
  .strict();
const SummaryRecordSchema = z
  .object({
    kind: z.literal('session-summary'),
    summary: z.string(),
    ...CreatedAt,
  })
  .strict();
const RunStartedRecordSchema = z
  .object({
    kind: z.literal('run-marker'),
    runId: z.string(),
    status: z.literal('started'),
    ...CreatedAt,
  })
  .strict();
const RunCompletedRecordSchema = z
  .object({
    kind: z.literal('run-marker'),
    runId: z.string(),
    status: z.literal('completed'),
    finishReason: z.enum([
      'stop',
      'length',
      'content-filter',
      'tool-calls',
      'approval-required',
      'tool-result-required',
      'interrupted',
      'no-progress',
      'error',
      'unknown',
    ]),
    usage: Usage,
    ...CreatedAt,
  })
  .strict();
const RunFailedRecordSchema = z
  .object({
    kind: z.literal('run-marker'),
    runId: z.string(),
    status: z.literal('failed'),
    error: z.object({ name: z.string(), message: z.string() }).strict(),
    ...CreatedAt,
  })
  .strict();

/** 模式事件是恢复时的唯一事实源；strict 防止旧字段静默混入新协议。 */
const SessionModeRecordSchema = z
  .object({
    kind: z.literal('session.mode.changed'),
    mode: SessionModeSchema,
    previousMode: SessionModeSchema.nullable(),
    source: z.enum([
      'config',
      'shortcut',
      'slash-command',
      'plan-accept',
      'resume',
    ]),
    changedAt: z.string(),
  })
  .strict();
const PlanBaseSchema = z.object({
  sessionId: z.string(),
  contentHash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 与运行时 PlanRecord 保持同构，用 schema 在磁盘边界拦截非法字段组合。 */
const PlanRecordSchema = z.discriminatedUnion('status', [
  PlanBaseSchema.extend({ status: z.literal('draft') }).strict(),
  PlanBaseSchema.extend({
    status: z.literal('awaiting-approval'),
    requestId: z.string(),
  }).strict(),
  PlanBaseSchema.extend({
    status: z.literal('accepted'),
    executionSessionId: z.string(),
  }).strict(),
  PlanBaseSchema.extend({
    status: z.literal('rejected'),
    reason: z.string().nullable(),
  }).strict(),
]);
const PlanStateRecordSchema = z
  .object({
    kind: z.literal('plan.state'),
    event: z.enum([
      'plan.created',
      'plan.updated',
      'plan.approval.requested',
      'plan.accepted',
      'plan.chat.requested',
      'plan.rejected',
    ]),
    plan: PlanRecordSchema,
    createdAt: z.string(),
  })
  .strict();

/** Preview 是可审计的只读动作，不改变 Plan 当前状态。 */
const PlanPreviewedRecordSchema = z
  .object({
    kind: z.literal('plan.previewed'),
    sessionId: z.string(),
    contentHash: z.string(),
    createdAt: z.string(),
  })
  .strict();
const PlanExecutionStartedRecordSchema = z
  .object({
    kind: z.literal('plan.execution.started'),
    sourcePlanSessionId: z.string(),
    sourcePlanHash: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const SessionRecordSchema = z.union([
  HeaderRecordSchema,
  EntryRecordSchema,
  LeafRecordSchema,
  BranchRecordSchema,
  TitleRecordSchema,
  CompactionRecordSchema,
  ReplacementRecordSchema,
  SummaryRecordSchema,
  RunStartedRecordSchema,
  RunCompletedRecordSchema,
  RunFailedRecordSchema,
  SessionModeRecordSchema,
  PlanStateRecordSchema,
  PlanPreviewedRecordSchema,
  PlanExecutionStartedRecordSchema,
  GoalSessionRecordSchema,
  GoalClearedRecordSchema,
]);

export function parseSessionRecord(
  value: unknown,
  source: string,
): SessionRecord {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new Error(`Invalid session record at ${source}: missing kind.`);
  }
  const record = value as { readonly kind: unknown; readonly status?: unknown };
  const schema = selectRecordSchema(record.kind, record.status, source);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid session record at ${source}: ${parsed.error.message}`,
    );
  }
  return parsed.data as SessionRecord;
}

function selectRecordSchema(
  kind: unknown,
  status: unknown,
  source: string,
): z.ZodType {
  switch (kind) {
    case 'header':
      return HeaderRecordSchema;
    case 'entry':
      return EntryRecordSchema;
    case 'leaf':
      return LeafRecordSchema;
    case 'branch':
      return BranchRecordSchema;
    case 'session-title':
      return TitleRecordSchema;
    case 'compaction':
      return CompactionRecordSchema;
    case 'content-replacement':
      return ReplacementRecordSchema;
    case 'session-summary':
      return SummaryRecordSchema;
    case 'run-marker':
      if (status === 'started') return RunStartedRecordSchema;
      if (status === 'completed') return RunCompletedRecordSchema;
      if (status === 'failed') return RunFailedRecordSchema;
      throw new Error(
        `Invalid session record at ${source}: unknown run-marker status ${String(status)}.`,
      );
    case 'goal-state':
      return GoalSessionRecordSchema;
    case 'goal-cleared':
      return GoalClearedRecordSchema;
    case 'session.mode.changed':
      return SessionModeRecordSchema;
    case 'plan.state':
      return PlanStateRecordSchema;
    case 'plan.previewed':
      return PlanPreviewedRecordSchema;
    case 'plan.execution.started':
      return PlanExecutionStartedRecordSchema;
    default:
      throw new Error(
        `Invalid session record at ${source}: unknown kind ${String(kind)}.`,
      );
  }
}
