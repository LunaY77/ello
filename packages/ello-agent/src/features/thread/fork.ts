/**
 * Thread 快照裁剪与 fork record 重写。
 *
 * 所有 fork 都在这里验证截止 turn、复制 transcript，并重写 Thread、Turn、Item 与 Goal id。函数只操作
 * 已验证的快照和 record 数据，持久化顺序由调用方提供的 create/append 函数决定。
 */
import { createEntityId } from '../../ids.js';
import {
  AppServerError,
  type ThreadSnapshot,
  type Turn,
} from '../../protocol/v1/index.js';
import type {
  NewThreadRecord,
  ThreadRecord,
} from '../../storage/threads/thread-record.js';

/**
 * 按 protocol include flags 裁剪 Thread snapshot。
 *
 * Args:
 * - `snapshot`: 完整 Thread 快照。
 * - `includeTurns`: 是否保留 turn 列表。
 * - `includeItems`: 保留 turn 时是否保留 item 列表。
 *
 * Returns:
 * - 返回不修改原快照的裁剪结果。
 */
export function filterSnapshot(
  snapshot: ThreadSnapshot,
  includeTurns: boolean,
  includeItems: boolean,
): ThreadSnapshot {
  if (!includeTurns) return { ...snapshot, turns: [] };
  if (includeItems) return snapshot;
  return {
    ...snapshot,
    turns: snapshot.turns.map((turn) => ({ ...turn, items: [] })),
  };
}

interface ForkRecordOptions {
  readonly threadId: string;
  readonly source: ThreadSnapshot;
  readonly sourceRecords: ReadonlyArray<ThreadRecord>;
  readonly lastTurnId?: string;
  /**
   * 构造 Thread `fork` 模块 中的 `create` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Thread `fork` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread `fork` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  create(): Promise<ThreadRecord>;
  /**
   * 按 Thread `fork` 模块 的一致性约束执行 `append` 状态变更。
   *
   * Args:
   * - `record`: 要由 `append` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - Promise 在 Thread `fork` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread `fork` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  append(record: NewThreadRecord): Promise<ThreadRecord>;
}

/**
 * 生成并持久化 fork Thread 的完整初始 record 序列。
 *
 * Args:
 * - `options.threadId`: 新 Thread id。
 * - `options.source`: 包含 turn/items 的源快照。
 * - `options.sourceRecords`: 用于复制 transcript entries 的源 record 序列。
 * - `options.lastTurnId`: 可选的闭区间截止 turn。
 * - `options.create`: 写入新 Thread 首条 `thread.created` record 的函数。
 * - `options.append`: 按 seq 追加其余 fork records 的函数。
 *
 * Returns:
 * - 在全部 records 持久化后返回新 Thread 的有序 record 序列。
 */
export async function createForkRecords(
  options: ForkRecordOptions,
): Promise<ReadonlyArray<ThreadRecord>> {
  const sourceTurns = turnsThrough(options.source.turns, options.lastTurnId);
  if (sourceTurns.some((turn) => turn.status === 'inProgress')) {
    throw new AppServerError({
      type: 'threadBusy',
      message: 'Cannot fork an in-progress turn.',
    });
  }
  const records = [await options.create()];
  for (const sourceTurn of sourceTurns) {
    const turn = cloneTurn(sourceTurn, options.threadId);
    records.push(
      await options.append({
        kind: 'turn.started',
        turn: { ...turn, status: 'inProgress', items: [] },
      }),
    );
    for (const item of turn.items) {
      records.push(
        await options.append({ kind: 'item.started', turnId: turn.id, item }),
      );
      records.push(
        await options.append({ kind: 'item.completed', turnId: turn.id, item }),
      );
    }
    for (const transcript of options.sourceRecords) {
      if (
        transcript.kind !== 'transcript.entry' ||
        transcript.turnId !== sourceTurn.id
      ) {
        continue;
      }
      records.push(
        await options.append({
          kind: 'transcript.entry',
          turnId: turn.id,
          role: transcript.role,
          message: transcript.message,
        }),
      );
    }
    const terminal = { ...turn, items: [] };
    switch (terminal.status) {
      case 'completed':
        records.push(
          await options.append({ kind: 'turn.completed', turn: terminal }),
        );
        break;
      case 'interrupted':
        records.push(
          await options.append({
            kind: 'turn.interrupted',
            turn: terminal,
            reason: 'forked history',
          }),
        );
        break;
      case 'failed':
        records.push(
          await options.append({
            kind: 'turn.failed',
            turn: terminal,
            error: {
              code: terminal.errorCode ?? 'SOURCE_TURN_FAILED',
              message: 'Forked from a failed turn.',
            },
          }),
        );
        break;
      case 'inProgress':
        throw new Error(`Forked turn ${terminal.id} remained in progress.`);
      default:
        terminal.status satisfies never;
        throw new Error(
          `Unhandled fork turn status: ${String(terminal.status)}`,
        );
    }
  }
  if (options.source.goal !== null) {
    records.push(
      await options.append({
        kind: 'goal.state',
        goal: {
          ...options.source.goal,
          id: createEntityId('job'),
          status: 'paused',
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }
  return records;
}

function turnsThrough(
  turns: ReadonlyArray<Turn>,
  lastTurnId: string | undefined,
): ReadonlyArray<Turn> {
  if (lastTurnId === undefined) return turns;
  const index = turns.findIndex((turn) => turn.id === lastTurnId);
  if (index === -1) {
    throw new AppServerError({
      type: 'turnMismatch',
      message: `Fork turn ${lastTurnId} does not exist.`,
    });
  }
  return turns.slice(0, index + 1);
}

function cloneTurn(source: Turn, threadId: string): Turn {
  const turnId = createEntityId('turn');
  return {
    ...source,
    id: turnId,
    threadId,
    items: source.items.map((item) => ({
      ...item,
      id: createEntityId('item'),
      turnId,
    })),
  };
}
