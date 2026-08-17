/**
 * 本文件是子代理任务的唯一持久化门面。
 *
 * 普通读写全部通过 Drizzle schema 完成；只有 immediateTransaction 这一处基础设施 helper
 * 触碰 SQLite 事务原语。任务投影、transcript 和父模型通知在同一事务里提交，避免 UI 看到半成品。
 */
import { and, asc, desc, eq, sql, type InferSelectModel } from 'drizzle-orm';
import { z } from 'zod';

import { createEntityId } from '../../../ids.js';
import {
  immediateTransaction,
  type CodingDatabase,
} from '../../../infra/database/index.js';
import {
  agentTaskEvents,
  agentTaskNotifications,
  agentTaskRoots,
  agentTasks,
} from '../../../infra/database/schema.js';
import type { AgentMessage, AgentUsage } from '../engine/index.js';

import { taskResultSummary } from './task-result.js';
import {
  AgentTaskCurrentToolSchema,
  AgentTaskIsolationSchema,
  AgentTaskPacketSchema,
  AgentTaskResultSchema,
  AgentTaskStatusSchema,
  AgentTaskToolSummarySchema,
  AgentUsageSchema,
  PermissionRuleListSchema,
  type AgentTask,
  type AgentTaskChange,
  type AgentTaskCurrentTool,
  type AgentTaskEvent,
  type AgentTaskNotification,
  type AgentTaskResult,
  type AgentTaskStatus,
  type AgentTaskSnapshot,
  type AgentTaskToolSummary,
  type CreateAgentTask,
  isTerminalAgentTaskStatus,
} from './task-types.js';

export {
  AgentTaskIsolationSchema,
  AgentTaskPacketSchema,
  AgentTaskResultSchema,
  AgentTaskStatusSchema,
  AgentUsageSchema,
  type AgentTask,
  type AgentTaskChange,
  type AgentTaskCurrentTool,
  type AgentTaskEvent,
  type AgentTaskIsolation,
  type AgentTaskNotification,
  type AgentTaskPacket,
  type AgentTaskResult,
  type AgentTaskSnapshot,
  type AgentTaskStatus,
  type AgentTaskToolSummary,
  type CreateAgentTask,
} from './task-types.js';

type AgentTaskRow = InferSelectModel<typeof agentTasks>;
type AgentTaskEventRow = InferSelectModel<typeof agentTaskEvents>;
type AgentTaskNotificationRow = InferSelectModel<typeof agentTaskNotifications>;

const TerminalStatusSchema = z.enum([
  'completed',
  'failed',
  'blocked',
  'stopped',
]);

/** 子代理任务和 transcript 的 Drizzle 持久化入口。 */
export class AgentTaskStore {
  /**
   * 创建任务持久化门面；数据库连接的关闭责任仍由 composition root 持有。
   *
   * Args:
   * - `database`: 已完成迁移的进程级 Drizzle 数据库。
   */
  constructor(private readonly database: CodingDatabase) {}

  /** 创建 queued 任务，并写入首条 created 事件。 */
  create(input: CreateAgentTask): AgentTask {
    return this.createChange(input).task;
  }

  /** 创建任务并返回可直接广播给订阅者的变化。 */
  createChange(input: CreateAgentTask): AgentTaskChange {
    return immediateTransaction(this.database, (tx) => {
      const now = new Date().toISOString();
      const taskId = createEntityId('job');
      const task: AgentTask = {
        ...input,
        id: taskId,
        agentId: createEntityId('agent'),
        status: 'queued',
        revision: 0,
        eventSequence: 0,
        toolCount: 0,
        recentTools: [],
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(agentTaskRoots)
        .values({
          rootThreadId: task.rootThreadId,
          sequence: 0,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
      tx.insert(agentTasks).values(toTaskRow(task)).run();
      return appendEvent(tx, task, 'created', {
        description: task.description,
        objective: task.taskPacket.objective,
        scope: task.taskPacket.scope,
      });
    });
  }

  /** 按 taskId、agentId 或 root thread 内的名称读取任务。 */
  get(selector: string, rootThreadId?: string): AgentTask | undefined {
    const row = selector.startsWith('job_')
      ? this.database
          .select()
          .from(agentTasks)
          .where(eq(agentTasks.id, selector))
          .get()
      : selector.startsWith('agent_')
        ? this.database
            .select()
            .from(agentTasks)
            .where(eq(agentTasks.agentId, selector))
            .get()
        : rootThreadId === undefined
          ? undefined
          : this.database
              .select()
              .from(agentTasks)
              .where(
                and(
                  eq(agentTasks.rootThreadId, rootThreadId),
                  eq(agentTasks.name, selector),
                ),
              )
              .get();
    return row === undefined ? undefined : parseTaskRow(row);
  }

  /** 列出 root thread 下全部任务，顺序与 Agent switcher 保持稳定。 */
  list(rootThreadId: string): readonly AgentTask[] {
    return this.database
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.rootThreadId, rootThreadId))
      .orderBy(asc(agentTasks.createdAt), asc(agentTasks.id))
      .all()
      .map(parseTaskRow);
  }

  /** 读取带 root sequence 屏障的任务列表。 */
  snapshot(rootThreadId: string): AgentTaskSnapshot {
    return immediateTransaction(this.database, (tx) => {
      const root = tx
        .select()
        .from(agentTaskRoots)
        .where(eq(agentTaskRoots.rootThreadId, rootThreadId))
        .get();
      const tasks = tx
        .select()
        .from(agentTasks)
        .where(eq(agentTasks.rootThreadId, rootThreadId))
        .orderBy(asc(agentTasks.createdAt), asc(agentTasks.id))
        .all()
        .map(parseTaskRow);
      return {
        rootThreadId,
        rootSequence: root?.sequence ?? 0,
        tasks,
      };
    });
  }

  /** 读取 task transcript，并拒绝返回存在序号缺口的损坏流。 */
  events(taskId: string, afterSequence = 0): readonly AgentTaskEvent[] {
    const rows = this.database
      .select()
      .from(agentTaskEvents)
      .where(
        and(
          eq(agentTaskEvents.taskId, taskId),
          sql`${agentTaskEvents.sequence} > ${afterSequence}`,
        ),
      )
      .orderBy(asc(agentTaskEvents.sequence))
      .all();
    let expected = afterSequence + 1;
    const events = rows.map((row) => {
      if (row.sequence !== expected) {
        throw new Error(
          `Agent task ${taskId} transcript has a sequence gap at ${expected}.`,
        );
      }
      expected += 1;
      return parseEventRow(row);
    });
    return events;
  }

  /** 原子领取 queued 任务；只有一个运行者可以成功 claim。 */
  markRunning(taskId: string): AgentTask | undefined {
    return this.markRunningChange(taskId)?.task;
  }

  /** 领取任务并返回运行状态事件。 */
  markRunningChange(taskId: string): AgentTaskChange | undefined {
    return immediateTransaction(this.database, (tx) => {
      const current = requireTask(tx, taskId);
      if (current.status !== 'queued') return undefined;
      const now = new Date().toISOString();
      return appendEvent(
        tx,
        current,
        'status',
        {
          from: current.status,
          to: 'running',
        },
        {
          status: 'running',
          startedAt: now,
          errorMessage: null,
        },
      );
    });
  }

  /** 记录 steer，并在当前进程有 run 时由 Service 继续把文本送入运行句柄。 */
  recordSteer(taskId: string, steerId: string, text: string): AgentTaskChange {
    return immediateTransaction(this.database, (tx) => {
      const current = requireTask(tx, taskId);
      const existing = tx
        .select()
        .from(agentTaskEvents)
        .where(
          and(
            eq(agentTaskEvents.taskId, taskId),
            eq(agentTaskEvents.dedupeKey, steerId),
          ),
        )
        .get();
      if (existing !== undefined) {
        return { task: current, event: parseEventRow(existing) };
      }
      return appendEvent(
        tx,
        current,
        'steer.queued',
        { steerId, text },
        {},
        steerId,
      );
    });
  }

  /** 记录 AgentRun 事件，同时更新列表所需的 current tool 与 usage 投影。 */
  append(
    taskId: string,
    eventType: string,
    payload: unknown,
    projection: {
      readonly currentTool?: AgentTaskCurrentTool | null;
      readonly toolCount?: number;
      readonly recentTools?: readonly AgentTaskToolSummary[];
      readonly usage?: AgentUsage;
    } = {},
    dedupeKey?: string,
  ): AgentTaskChange {
    return immediateTransaction(this.database, (tx) => {
      const current = requireTask(tx, taskId);
      if (dedupeKey !== undefined) {
        const existing = tx
          .select()
          .from(agentTaskEvents)
          .where(
            and(
              eq(agentTaskEvents.taskId, taskId),
              eq(agentTaskEvents.dedupeKey, dedupeKey),
            ),
          )
          .get();
        if (existing !== undefined) {
          return { task: current, event: parseEventRow(existing) };
        }
      }
      return appendEvent(
        tx,
        current,
        eventType,
        payload,
        projection,
        dedupeKey,
      );
    });
  }

  /** 写入终态、结果和唯一父模型通知；重复结算保持幂等。 */
  settle(
    taskId: string,
    result: {
      readonly result: AgentTaskResult;
      readonly output?: string;
      readonly errorMessage?: string;
      readonly usage?: AgentUsage;
      readonly sidechain?: readonly AgentMessage[];
    },
  ): AgentTask {
    return this.settleChange(taskId, result).task;
  }

  /** 终态变化的完整版本，供 Service 广播 transcript 更新。 */
  settleChange(
    taskId: string,
    result: {
      readonly result: AgentTaskResult;
      readonly output?: string;
      readonly errorMessage?: string;
      readonly usage?: AgentUsage;
      readonly sidechain?: readonly AgentMessage[];
    },
  ): AgentTaskChange {
    return immediateTransaction(this.database, (tx) => {
      const current = requireTask(tx, taskId);
      if (isTerminalAgentTaskStatus(current.status)) {
        return { task: current, event: latestEvent(tx, taskId) };
      }
      const sidechain = result.sidechain ?? current.sidechain;
      const status = result.result.status;
      const summary = taskResultSummary(result.result);
      const change = appendEvent(
        tx,
        current,
        `status.${status}`,
        {
          status,
          result: result.result,
          ...(result.errorMessage === undefined
            ? {}
            : { errorMessage: result.errorMessage }),
        },
        {
          output: result.output ?? null,
          errorMessage: result.errorMessage ?? null,
          result: result.result,
          resultPreview: boundedPreview(summary),
          errorPreview:
            status === 'failed' || status === 'stopped'
              ? boundedPreview(summary)
              : null,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          sidechain,
          completedAt: new Date().toISOString(),
          currentTool: null,
          status,
        },
      );
      const notification = notificationFor(change.task);
      tx.insert(agentTaskNotifications)
        .values({
          id: notification.id,
          taskId: notification.taskId,
          rootThreadId: notification.rootThreadId,
          status: notification.status,
          payloadJson: JSON.stringify({
            summary: notification.summary,
            result: notification.result,
            ...(notification.usage === undefined
              ? {}
              : { usage: notification.usage }),
          }),
          createdAt: notification.createdAt,
          deliveredAt: null,
        })
        .onConflictDoNothing({ target: agentTaskNotifications.taskId })
        .run();
      return change;
    });
  }

  /** Server 重启时把遗留 queued/running 任务收口为 failed，并留下审计事件。 */
  recoverRunning(): number {
    return immediateTransaction(this.database, (tx) => {
      const interrupted = tx
        .select()
        .from(agentTasks)
        .where(sql`${agentTasks.status} in ('queued', 'running')`)
        .orderBy(asc(agentTasks.createdAt), asc(agentTasks.id))
        .all()
        .map(parseTaskRow);
      for (const task of interrupted) {
        const result: AgentTaskResult = {
          status: 'failed',
          summary: 'Subagent execution was interrupted by a Server restart.',
          error:
            'Server restarted before the Agent Task reached a terminal result.',
          evidence: [],
          retryable: true,
        };
        const change = appendEvent(
          tx,
          task,
          'status.failed',
          { status: 'failed', result },
          {
            status: 'failed',
            errorMessage: 'Server restarted while the task was running.',
            result,
            resultPreview: boundedPreview(taskResultSummary(result)),
            errorPreview: boundedPreview(taskResultSummary(result)),
            completedAt: new Date().toISOString(),
            currentTool: null,
          },
        );
        const notification = notificationFor(change.task);
        tx.insert(agentTaskNotifications)
          .values({
            id: notification.id,
            taskId: notification.taskId,
            rootThreadId: notification.rootThreadId,
            status: notification.status,
            payloadJson: JSON.stringify({
              summary: notification.summary,
              result: notification.result,
            }),
            createdAt: notification.createdAt,
            deliveredAt: null,
          })
          .onConflictDoNothing({ target: agentTaskNotifications.taskId })
          .run();
      }
      return interrupted.length;
    });
  }

  /** 读取父模型尚未消费的完成通知。 */
  pendingNotifications(rootThreadId: string): readonly AgentTaskNotification[] {
    return this.database
      .select()
      .from(agentTaskNotifications)
      .where(
        and(
          eq(agentTaskNotifications.rootThreadId, rootThreadId),
          sql`${agentTaskNotifications.deliveredAt} is null`,
        ),
      )
      .orderBy(
        asc(agentTaskNotifications.createdAt),
        asc(agentTaskNotifications.id),
      )
      .all()
      .map(parseNotificationRow);
  }

  /** 原子标记通知已送入父模型上下文；重复调用不会改变首次时间。 */
  markNotificationsDelivered(notificationIds: readonly string[]): void {
    if (notificationIds.length === 0) return;
    immediateTransaction(this.database, (tx) => {
      const deliveredAt = new Date().toISOString();
      for (const id of notificationIds) {
        tx.update(agentTaskNotifications)
          .set({ deliveredAt })
          .where(
            and(
              eq(agentTaskNotifications.id, id),
              sql`${agentTaskNotifications.deliveredAt} is null`,
            ),
          )
          .run();
      }
    });
  }

  /** 通过 selector 读取 root thread 内的任务，找不到时抛出稳定错误。 */
  requireForRoot(selector: string, rootThreadId: string): AgentTask {
    const task = this.get(selector, rootThreadId);
    if (task === undefined || task.rootThreadId !== rootThreadId) {
      throw new Error(`Unknown agent task: ${selector}`);
    }
    return task;
  }

  /** 读取指定 task；内部 Service 只在已完成 root 校验后调用。 */
  require(taskId: string): AgentTask {
    const task = this.get(taskId);
    if (task === undefined) throw new Error(`Unknown agent task: ${taskId}`);
    return task;
  }
}

function appendEvent(
  tx: CodingDatabase,
  current: AgentTask,
  eventType: string,
  payload: unknown,
  projection: {
    readonly status?: AgentTaskStatus;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly output?: string | null;
    readonly errorMessage?: string | null;
    readonly result?: AgentTaskResult;
    readonly currentTool?: AgentTaskCurrentTool | null;
    readonly toolCount?: number;
    readonly recentTools?: readonly AgentTaskToolSummary[];
    readonly resultPreview?: string | null;
    readonly errorPreview?: string | null;
    readonly usage?: AgentUsage;
    readonly sidechain?: readonly AgentMessage[];
  } = {},
  dedupeKey?: string,
): AgentTaskChange {
  const now = new Date().toISOString();
  const rootSequence = nextRootSequence(tx, current.rootThreadId, now);
  const sequence = current.eventSequence + 1;
  const taskUpdate = {
    revision: current.revision + 1,
    eventSequence: sequence,
    updatedAt: now,
    ...(projection.status === undefined ? {} : { status: projection.status }),
    ...(projection.startedAt === undefined
      ? {}
      : { startedAt: projection.startedAt }),
    ...(projection.completedAt === undefined
      ? {}
      : { completedAt: projection.completedAt }),
    ...(projection.output === undefined ? {} : { output: projection.output }),
    ...(projection.errorMessage === undefined
      ? {}
      : { errorMessage: projection.errorMessage }),
    ...(projection.result === undefined
      ? {}
      : { resultJson: JSON.stringify(projection.result) }),
    ...(projection.currentTool === undefined
      ? {}
      : {
          currentToolJson:
            projection.currentTool === null
              ? null
              : JSON.stringify(projection.currentTool),
        }),
    ...(projection.toolCount === undefined
      ? {}
      : { toolCount: projection.toolCount }),
    ...(projection.recentTools === undefined
      ? {}
      : { recentToolsJson: JSON.stringify(projection.recentTools) }),
    ...(projection.resultPreview === undefined
      ? {}
      : { resultPreview: projection.resultPreview }),
    ...(projection.errorPreview === undefined
      ? {}
      : { errorPreview: projection.errorPreview }),
    ...(projection.usage === undefined
      ? {}
      : { usageJson: JSON.stringify(projection.usage) }),
    ...(projection.sidechain === undefined
      ? {}
      : { sidechainJson: JSON.stringify(projection.sidechain) }),
  };
  tx.update(agentTasks)
    .set(taskUpdate)
    .where(eq(agentTasks.id, current.id))
    .run();
  const boundedPayload = normalizeJsonValue(payload);
  tx.insert(agentTaskEvents)
    .values({
      rootThreadId: current.rootThreadId,
      taskId: current.id,
      sequence,
      rootSequence,
      dedupeKey: dedupeKey ?? null,
      eventType,
      payloadJson: JSON.stringify(boundedPayload),
      createdAt: now,
    })
    .run();
  const row = requireTaskRow(tx, current.id);
  return {
    task: parseTaskRow(row),
    event: {
      rootThreadId: current.rootThreadId,
      taskId: current.id,
      sequence,
      rootSequence,
      eventType,
      payload: boundedPayload,
      createdAt: now,
    },
  };
}

function nextRootSequence(
  tx: CodingDatabase,
  rootThreadId: string,
  now: string,
): number {
  tx.insert(agentTaskRoots)
    .values({ rootThreadId, sequence: 0, updatedAt: now })
    .onConflictDoNothing()
    .run();
  tx.update(agentTaskRoots)
    .set({ sequence: sql`${agentTaskRoots.sequence} + 1`, updatedAt: now })
    .where(eq(agentTaskRoots.rootThreadId, rootThreadId))
    .run();
  const root = tx
    .select()
    .from(agentTaskRoots)
    .where(eq(agentTaskRoots.rootThreadId, rootThreadId))
    .get();
  if (root === undefined)
    throw new Error(`Missing Agent task root ${rootThreadId}.`);
  return root.sequence;
}

function toTaskRow(task: AgentTask) {
  return {
    id: task.id,
    agentId: task.agentId,
    rootThreadId: task.rootThreadId,
    name: task.name ?? null,
    description: task.description,
    definitionName: task.definitionName,
    modelSelector: task.modelSelector ?? null,
    status: task.status,
    taskPacketJson: JSON.stringify(task.taskPacket),
    cwd: task.cwd,
    isolation: task.isolation,
    maxTurns: task.maxTurns,
    revision: task.revision,
    eventSequence: task.eventSequence,
    currentToolJson: null,
    toolCount: task.toolCount,
    recentToolsJson: JSON.stringify(task.recentTools),
    resultPreview: task.resultPreview ?? null,
    errorPreview: task.errorPreview ?? null,
    output: null,
    errorMessage: null,
    resultJson: null,
    usageJson: null,
    sidechainJson: JSON.stringify(task.sidechain),
    permissionRulesJson: JSON.stringify(task.permissionRules),
    externalPathsJson: JSON.stringify(task.externalPaths),
    createdAt: task.createdAt,
    startedAt: null,
    completedAt: null,
    updatedAt: task.updatedAt,
  };
}

function requireTaskRow(tx: CodingDatabase, taskId: string): AgentTaskRow {
  const row = tx
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.id, taskId))
    .get();
  if (row === undefined) throw new Error(`Unknown agent task: ${taskId}`);
  return row;
}

function requireTask(tx: CodingDatabase, taskId: string): AgentTask {
  return parseTaskRow(requireTaskRow(tx, taskId));
}

function latestEvent(tx: CodingDatabase, taskId: string): AgentTaskEvent {
  const row = tx
    .select()
    .from(agentTaskEvents)
    .where(eq(agentTaskEvents.taskId, taskId))
    .orderBy(desc(agentTaskEvents.sequence))
    .get();
  if (row === undefined) throw new Error(`Agent task ${taskId} has no events.`);
  return parseEventRow(row);
}

function parseTaskRow(row: AgentTaskRow): AgentTask {
  const usage = parseJson(row.usageJson, AgentUsageSchema, 'usage', row.id);
  const currentTool = parseJson(
    row.currentToolJson,
    AgentTaskCurrentToolSchema,
    'current_tool',
    row.id,
  );
  const recentTools = z
    .array(AgentTaskToolSummarySchema)
    .max(4)
    .parse(parseJsonUnknown(row.recentToolsJson, 'recent_tools', row.id))
    .map(
      (tool): AgentTaskToolSummary => ({
        toolCallId: tool.toolCallId,
        name: tool.name,
        invocationPreview: tool.invocationPreview,
        status: tool.status,
        startedAt: tool.startedAt,
        ...(tool.completedAt === undefined
          ? {}
          : { completedAt: tool.completedAt }),
      }),
    );
  const sidechain = parseUnknownArray(
    row.sidechainJson,
    'sidechain',
    row.id,
  ) as readonly AgentMessage[];
  const taskPacket = AgentTaskPacketSchema.parse(
    parseJsonUnknown(row.taskPacketJson, 'task_packet', row.id),
  );
  const result = parseJson(
    row.resultJson,
    AgentTaskResultSchema,
    'result',
    row.id,
  );
  const permissionRules = PermissionRuleListSchema.parse(
    parseJsonUnknown(row.permissionRulesJson, 'permission_rules', row.id),
  );
  const externalPaths = parseStringArray(
    row.externalPathsJson,
    'external_paths',
    row.id,
  );
  return {
    id: row.id,
    agentId: row.agentId,
    rootThreadId: row.rootThreadId,
    ...(row.name === null ? {} : { name: row.name }),
    description: row.description,
    definitionName: row.definitionName,
    ...(row.modelSelector === null
      ? {}
      : {
          modelSelector: row.modelSelector as
            | 'primary_model'
            | 'auxiliary_model',
        }),
    status: AgentTaskStatusSchema.parse(row.status),
    taskPacket,
    cwd: row.cwd,
    isolation: AgentTaskIsolationSchema.parse(row.isolation),
    maxTurns: row.maxTurns,
    revision: row.revision,
    eventSequence: row.eventSequence,
    ...(currentTool === undefined ? {} : { currentTool }),
    toolCount: row.toolCount,
    recentTools,
    ...(row.resultPreview === null ? {} : { resultPreview: row.resultPreview }),
    ...(row.errorPreview === null ? {} : { errorPreview: row.errorPreview }),
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.errorMessage === null ? {} : { errorMessage: row.errorMessage }),
    ...(result === undefined ? {} : { result }),
    ...(usage === undefined ? {} : { usage }),
    sidechain,
    permissionRules,
    externalPaths,
    createdAt: row.createdAt,
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
    updatedAt: row.updatedAt,
  };
}

function boundedPreview(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim();
  if (normalized === '') return null;
  return normalized.length <= 480 ? normalized : `${normalized.slice(0, 479)}…`;
}

function parseEventRow(row: AgentTaskEventRow): AgentTaskEvent {
  return {
    rootThreadId: row.rootThreadId,
    taskId: row.taskId,
    sequence: row.sequence,
    rootSequence: row.rootSequence,
    eventType: row.eventType,
    payload: parseJsonUnknown(row.payloadJson, 'payload', row.taskId),
    createdAt: row.createdAt,
  };
}

function parseNotificationRow(
  row: AgentTaskNotificationRow,
): AgentTaskNotification {
  const payload = z
    .object({
      summary: z.string(),
      result: AgentTaskResultSchema,
      usage: AgentUsageSchema.optional(),
    })
    .strict()
    .parse(
      parseJsonUnknown(row.payloadJson, 'notification_payload', row.taskId),
    );
  return {
    id: row.id,
    taskId: row.taskId,
    rootThreadId: row.rootThreadId,
    status: TerminalStatusSchema.parse(row.status),
    summary: payload.summary,
    result: payload.result,
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
    createdAt: row.createdAt,
    ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt }),
  };
}

function notificationFor(task: AgentTask): AgentTaskNotification {
  if (!isTerminalAgentTaskStatus(task.status)) {
    throw new Error(`Agent task ${task.id} has no terminal notification.`);
  }
  if (task.result === undefined) {
    throw new Error(`Agent task ${task.id} has no structured terminal result.`);
  }
  return {
    id: createEntityId('notification'),
    taskId: task.id,
    rootThreadId: task.rootThreadId,
    status: task.status,
    summary: `${task.definitionName}: ${taskResultSummary(task.result)}`,
    result: task.result,
    ...(task.usage === undefined ? {} : { usage: task.usage }),
    createdAt: task.updatedAt,
  };
}

function parseJsonUnknown(
  value: string | null,
  field: string,
  taskId: string,
): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${field} JSON for Agent task ${taskId}.`, {
      cause: error,
    });
  }
}

function parseJson<T>(
  value: string | null,
  schema: z.ZodType<T>,
  field: string,
  taskId: string,
): T | undefined {
  if (value === null) return undefined;
  return schema.parse(parseJsonUnknown(value, field, taskId));
}

function parseUnknownArray(
  value: string,
  field: string,
  taskId: string,
): readonly unknown[] {
  return z.array(z.unknown()).parse(parseJsonUnknown(value, field, taskId));
}

function parseStringArray(
  value: string,
  field: string,
  taskId: string,
): readonly string[] {
  return z.array(z.string()).parse(parseJsonUnknown(value, field, taskId));
}

function normalizeJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 256).map(normalizeJsonValue);
  if (typeof value === 'object') {
    const entries = Object.entries(value).slice(0, 256);
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, normalizeJsonValue(entry)]),
    );
  }
  return String(value);
}
