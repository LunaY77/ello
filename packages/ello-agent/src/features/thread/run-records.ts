/**
 * 本文件负责 thread feature 的“run-records”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createEntityId } from '../../ids.js';
import type {
  Goal,
  ThreadItem,
  ThreadSnapshot,
  Turn,
} from '../../protocol/v1/index.js';
import { JsonValueSchema } from '../../protocol/v1/index.js';
import type {
  NewThreadRecord,
  ThreadRecord,
} from '../../storage/threads/thread-record.js';
import type {
  AgentRun,
  AgentRunEvent,
  AgentInteraction,
} from '../agent/index.js';

import type { CompactionEntry } from './compact.js';
import {
  completedToolItem,
  failItem,
  startedToolItem,
  writtenGoal,
  writtenPlan,
} from './items.js';
import { serializeJsonValue } from './records.js';

interface ConsumeAgentRunOptions {
  /**
   * 读取 Thread `run-records` 模块 的 `snapshot` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回 `snapshot` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  snapshot(): ThreadSnapshot;
  /**
   * 在 Thread `run-records` 模块 中执行 `compactionEntries` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  compactionEntries(): ReadonlyArray<CompactionEntry>;
  /**
   * 按 Thread `run-records` 模块 的一致性约束执行 `append` 状态变更。
   *
   * Args:
   * - `record`: 要由 `append` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - Promise 在 Thread `run-records` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread `run-records` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  append(record: NewThreadRecord): Promise<ThreadRecord>;
  /**
   * 在 Thread `run-records` 模块 中执行 `enqueue` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `operation`: `enqueue` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Thread `run-records` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * 处理 Thread `run-records` 模块 的 `onFinished` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `turnId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `completed`: `onFinished` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Thread `run-records` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  onFinished(turnId: string, completed: boolean): void;
  /**
   * 构造 Thread `run-records` 模块 中的 `registerInteraction` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `turn`: `registerInteraction` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `interaction`: `registerInteraction` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `run`: `registerInteraction` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Thread `run-records` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  registerInteraction(
    turn: Turn,
    interaction: AgentInteraction,
    run: AgentRun,
  ): Promise<void>;
}

/**
 * 消费 Agent run，并把事件和最终结果按 mutation queue 顺序写成 Thread records。
 *
 * Args:
 * - `options`: 当前 Thread 的 snapshot、append、交互登记和串行 mutation 能力。
 * - `turn`: 已写入 `turn.started` 的活动 turn。
 * - `run`: 与该 turn 一一对应的 Agent run；本函数拥有其事件迭代和 final 等待顺序。
 * - `activeGoalId`: turn 启动时的 active Goal，用于把 usage 归属到稳定目标。
 *
 * Returns:
 * - 在事件流和 final result 都已收口、终态 records 已持久化后 resolve。
 */
export async function consumeAgentRun(
  options: ConsumeAgentRunOptions,
  turn: Turn,
  run: AgentRun,
  activeGoalId: string | undefined,
): Promise<void> {
  let eventFailure: unknown;
  try {
    for await (const event of run.events) {
      await options.enqueue(() =>
        recordAgentRunEvent(options, turn, run, event),
      );
    }
  } catch (error) {
    eventFailure = error;
  }
  try {
    const result = await run.result;
    await options.enqueue(async () => {
      // events 与 final 是独立信号，事件流失败不能被 completed final 覆盖。
      if (eventFailure !== undefined && result.status === 'completed') {
        await finishAgentRun(
          options,
          turn,
          {
            status: 'failed',
            error: {
              code: 'EXECUTION_FAILED',
              message: errorMessage(eventFailure),
            },
          },
          activeGoalId,
        );
        return;
      }
      switch (result.status) {
        case 'completed':
          await finishAgentRun(
            options,
            turn,
            { status: 'completed', usage: result.usage },
            activeGoalId,
          );
          return;
        case 'interrupted':
          await finishAgentRun(
            options,
            turn,
            {
              status: 'interrupted',
              usage: result.usage,
              reason: result.reason,
            },
            activeGoalId,
          );
          return;
        case 'failed':
          await finishAgentRun(
            options,
            turn,
            { status: 'failed', usage: result.usage, error: result.error },
            activeGoalId,
          );
          return;
        default:
          result satisfies never;
          throw new Error(`Unhandled turn result: ${String(result)}`);
      }
    });
  } catch (error) {
    const failure = eventFailure ?? error;
    await options.enqueue(() =>
      finishAgentRun(
        options,
        turn,
        {
          status: 'failed',
          error: { code: 'EXECUTION_FAILED', message: errorMessage(failure) },
        },
        activeGoalId,
      ),
    );
  }
}

async function recordAgentRunEvent(
  options: ConsumeAgentRunOptions,
  turn: Turn,
  run: AgentRun,
  event: AgentRunEvent,
): Promise<void> {
  switch (event.type) {
    case 'messageStarted': {
      const item: ThreadItem = {
        type: 'agentMessage',
        id: event.messageId,
        turnId: turn.id,
        createdAt: event.occurredAt,
        text: '',
        phase: 'final',
        status: 'inProgress',
      };
      await options.append({
        kind: 'item.started',
        turnId: turn.id,
        item,
      });
      return;
    }
    case 'messageDelta':
      await options.append({
        kind: 'item.delta',
        turnId: turn.id,
        itemId: event.messageId,
        delta: { type: 'agentMessage', text: event.text },
      });
      return;
    case 'messageCompleted': {
      const current = requireAgentMessage(options, event.messageId);
      await options.append({
        kind: 'item.completed',
        turnId: turn.id,
        item: { ...current, text: event.text, status: 'completed' },
      });
      return;
    }
    case 'toolStarted': {
      const existing = findItem(options, event.toolCallId);
      if (existing !== undefined) {
        if ('status' in existing && existing.status === 'inProgress') return;
        throw new Error(
          `Tool item ${event.toolCallId} started more than once.`,
        );
      }
      await options.append({
        kind: 'item.started',
        turnId: turn.id,
        item: startedToolItem(
          event.toolCallId,
          turn,
          event.name,
          event.input,
          event.occurredAt,
          options.snapshot().thread.cwd,
        ),
      });
      return;
    }
    case 'toolCompleted': {
      const item = completedToolItem(
        requireItem(options, event.toolCallId),
        event.output,
        event.occurredAt,
      );
      await options.append({
        kind: 'item.completed',
        turnId: turn.id,
        item,
      });
      const plan = writtenPlan(event.output);
      if (plan !== undefined) {
        await options.append({ kind: 'plan.state', plan });
      }
      const goal = writtenGoal(event.output);
      if (goal !== undefined) {
        await options.append({ kind: 'goal.state', goal });
      }
      return;
    }
    case 'toolFailed':
      await options.append({
        kind: 'item.completed',
        turnId: turn.id,
        item: failItem(requireItem(options, event.toolCallId), event.message),
      });
      return;
    case 'interactionRequired':
      await options.registerInteraction(turn, event.interaction, run);
      return;
    case 'contextCompacted': {
      const firstKept = options.compactionEntries().at(-event.keptMessageCount);
      if (firstKept === undefined) {
        throw new Error(
          `Compaction kept ${event.keptMessageCount} messages outside the current Thread history.`,
        );
      }
      await options.append({
        kind: 'compaction',
        turnId: turn.id,
        summary: event.summary,
        firstKeptSeq: firstKept.seq,
        tokensBefore: event.tokensBefore,
      });
      const item: ThreadItem = {
        type: 'contextCompaction',
        id: createEntityId('item'),
        turnId: turn.id,
        createdAt: event.occurredAt,
        summary: `${event.beforeMessageCount} -> ${event.afterMessageCount} messages`,
        tokensBefore: 0,
        status: 'completed',
      };
      await options.append({
        kind: 'item.started',
        turnId: turn.id,
        item: { ...item, status: 'inProgress' },
      });
      await options.append({
        kind: 'item.completed',
        turnId: turn.id,
        item,
      });
      return;
    }
    case 'runFailed': {
      const item: ThreadItem = {
        type: 'error',
        id: createEntityId('item'),
        turnId: turn.id,
        createdAt: event.occurredAt,
        code: event.code,
        message: event.message,
      };
      await options.append({
        kind: 'item.started',
        turnId: turn.id,
        item,
      });
      await options.append({
        kind: 'item.completed',
        turnId: turn.id,
        item,
      });
      return;
    }
    case 'messagesAppended':
      for (const message of event.messages) {
        await options.append({
          kind: 'transcript.entry',
          turnId: turn.id,
          role: message.role,
          message: normalizeTranscriptMessage(message),
        });
      }
      return;
    default:
      event satisfies never;
      throw new Error(`Unhandled Agent run event: ${String(event)}`);
  }
}

function findItem(
  options: ConsumeAgentRunOptions,
  itemId: string,
): ThreadItem | undefined {
  return options
    .snapshot()
    .turns.flatMap((turn) => turn.items)
    .find((item) => item.id === itemId);
}

function requireItem(
  options: ConsumeAgentRunOptions,
  itemId: string,
): ThreadItem {
  const item = findItem(options, itemId);
  if (item === undefined) throw new Error(`Unknown Thread item ${itemId}.`);
  return item;
}

function requireAgentMessage(
  options: ConsumeAgentRunOptions,
  itemId: string,
): Extract<ThreadItem, { type: 'agentMessage' }> {
  const item = requireItem(options, itemId);
  if (item.type !== 'agentMessage') {
    throw new Error(
      `Thread item ${itemId} is ${item.type}, expected agentMessage.`,
    );
  }
  return item;
}

async function finishAgentRun(
  options: ConsumeAgentRunOptions,
  started: Turn,
  result:
    | { readonly status: 'completed'; readonly usage?: Turn['usage'] }
    | {
        readonly status: 'interrupted';
        readonly usage?: Turn['usage'];
        readonly reason: string;
      }
    | {
        readonly status: 'failed';
        readonly usage?: Turn['usage'];
        readonly error: { readonly code: string; readonly message: string };
      },
  activeGoalId?: string,
): Promise<void> {
  const cumulativeUsage =
    result.usage === undefined
      ? undefined
      : addUsage(options.snapshot().usage, result.usage);
  const turn: Turn = {
    ...started,
    status: result.status,
    items: [],
    completedAt: new Date().toISOString(),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.status === 'failed' ? { errorCode: result.error.code } : {}),
  };
  if (result.status === 'completed') {
    await options.append({ kind: 'turn.completed', turn });
  } else if (result.status === 'interrupted') {
    await options.append({
      kind: 'turn.interrupted',
      turn,
      reason: result.reason,
    });
  } else {
    await options.append({
      kind: 'turn.failed',
      turn,
      error: result.error,
    });
  }
  await options.append({
    kind: 'thread.status',
    status:
      result.status === 'completed'
        ? 'idle'
        : result.status === 'interrupted'
          ? 'interrupted'
          : 'failed',
    activeFlags: [],
  });
  if (result.usage !== undefined) {
    if (cumulativeUsage === undefined) {
      throw new Error('Cumulative usage was not computed for a used turn.');
    }
    await options.append({
      kind: 'usage.updated',
      usage: cumulativeUsage,
    });
    const goal = options.snapshot().goal;
    if (activeGoalId !== undefined && goal?.id === activeGoalId) {
      await options.append({
        kind: 'goal.state',
        goal: nextGoalAfterUsage(goal, result.usage),
      });
    }
  }
  options.onFinished(started.id, result.status === 'completed');
}

function addUsage(
  left: NonNullable<Turn['usage']>,
  right: NonNullable<Turn['usage']>,
): NonNullable<Turn['usage']> {
  return {
    requests: left.requests + right.requests,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    toolCalls: left.toolCalls + right.toolCalls,
  };
}

function nextGoalAfterUsage(
  goal: Goal,
  usage: NonNullable<Turn['usage']>,
): Goal {
  const tokensUsed =
    goal.tokensUsed +
    Math.max(0, usage.inputTokens - usage.cacheReadTokens) +
    usage.outputTokens;
  return {
    ...goal,
    tokensUsed,
    status:
      goal.status === 'active' &&
      goal.tokenBudget !== undefined &&
      tokensUsed >= goal.tokenBudget
        ? 'paused'
        : goal.status,
    updatedAt: new Date().toISOString(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeTranscriptMessage(message: unknown) {
  return JsonValueSchema.parse(serializeJsonValue(message));
}
