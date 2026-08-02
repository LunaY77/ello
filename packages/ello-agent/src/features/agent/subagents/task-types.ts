/**
 * 本文件集中定义子代理任务的领域类型。
 *
 * 持久层、运行时和 RPC 投影共享这些闭合状态，不在各层重复解释数据库字段。
 */
import { z } from 'zod';

import {
  PermissionRuleSchema,
  type PermissionRule,
} from '../../config/index.js';
import type { AgentMessage, AgentUsage } from '../engine/index.js';

export const AgentTaskContextModeSchema = z.enum(['fresh', 'fork']);
export type AgentTaskContextMode = z.infer<typeof AgentTaskContextModeSchema>;

export const AgentTaskExecutionModeSchema = z.enum([
  'foreground',
  'background',
]);
export type AgentTaskExecutionMode = z.infer<
  typeof AgentTaskExecutionModeSchema
>;

export const AgentTaskStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'killed',
  'recovered',
]);
export type AgentTaskStatus = z.infer<typeof AgentTaskStatusSchema>;

export const AgentTaskIsolationSchema = z.enum([
  'shared',
  'worktree',
  'container',
]);
export type AgentTaskIsolation = z.infer<typeof AgentTaskIsolationSchema>;

export const AgentUsageSchema = z
  .object({
    requests: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    lastInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
  })
  .strict();

export const AgentTaskCurrentToolSchema = z
  .object({
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    startedAt: z.string().min(1),
  })
  .strict();

export interface AgentTaskCurrentTool {
  readonly toolCallId: string;
  readonly name: string;
  readonly startedAt: string;
}

export const AgentTaskToolSummarySchema = z
  .object({
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    invocationPreview: z.string(),
    status: z.enum(['running', 'completed', 'failed']),
    startedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),
  })
  .strict();

export interface AgentTaskToolSummary {
  readonly toolCallId: string;
  readonly name: string;
  readonly invocationPreview: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly startedAt: string;
  readonly completedAt?: string;
}

/** 子代理任务的完整持久快照。 */
export interface AgentTask {
  readonly id: string;
  readonly agentId: string;
  readonly rootThreadId: string;
  readonly parentTaskId?: string;
  readonly resumeFromTaskId?: string;
  readonly name?: string;
  readonly description: string;
  readonly definitionName: string;
  readonly modelSelector?: 'primary_model' | 'auxiliary_model';
  readonly contextMode: AgentTaskContextMode;
  readonly executionMode: AgentTaskExecutionMode;
  readonly status: AgentTaskStatus;
  readonly prompt: string;
  readonly cwd: string;
  readonly isolation: AgentTaskIsolation;
  readonly maxTurns: number;
  readonly depth: number;
  readonly revision: number;
  readonly eventSequence: number;
  readonly currentTool?: AgentTaskCurrentTool;
  readonly toolCount: number;
  readonly recentTools: readonly AgentTaskToolSummary[];
  readonly resultPreview?: string;
  readonly errorPreview?: string;
  readonly output?: string;
  readonly errorMessage?: string;
  readonly usage?: AgentUsage;
  readonly sidechain: readonly AgentMessage[];
  readonly toolNames: readonly string[];
  readonly permissionRules: readonly PermissionRule[];
  readonly externalPaths: readonly string[];
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly updatedAt: string;
}

/** 创建任务时必须一次性固定的运行参数。 */
export type CreateAgentTask = Omit<
  AgentTask,
  | 'id'
  | 'agentId'
  | 'status'
  | 'revision'
  | 'eventSequence'
  | 'currentTool'
  | 'toolCount'
  | 'recentTools'
  | 'resultPreview'
  | 'errorPreview'
  | 'output'
  | 'errorMessage'
  | 'usage'
  | 'createdAt'
  | 'startedAt'
  | 'completedAt'
  | 'updatedAt'
>;

/** transcript 中一条已经分配双重连续序号的持久事件。 */
export interface AgentTaskEvent {
  readonly rootThreadId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly rootSequence: number;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

/** 一次 task 变化对外发布的完整投影。 */
export interface AgentTaskChange {
  readonly task: AgentTask;
  readonly event: AgentTaskEvent;
}

/** 父模型完成通知的持久快照。 */
export interface AgentTaskNotification {
  readonly id: string;
  readonly taskId: string;
  readonly rootThreadId: string;
  readonly status: Extract<
    AgentTaskStatus,
    'completed' | 'failed' | 'killed' | 'recovered'
  >;
  readonly summary: string;
  readonly result?: string;
  readonly usage?: AgentUsage;
  readonly createdAt: string;
  readonly deliveredAt?: string;
}

/** root thread 当前任务树与连续序号的读取屏障。 */
export interface AgentTaskSnapshot {
  readonly rootThreadId: string;
  readonly rootSequence: number;
  readonly tasks: readonly AgentTask[];
}

export const PermissionRuleListSchema = z.array(PermissionRuleSchema);

/** 判断状态是否已经不可再运行。 */
export function isTerminalAgentTaskStatus(
  status: AgentTaskStatus,
): status is Extract<
  AgentTaskStatus,
  'completed' | 'failed' | 'killed' | 'recovered'
> {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'killed' ||
    status === 'recovered'
  );
}
