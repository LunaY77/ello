/**
 * Thread feature 的进程级 use cases。
 *
 * 本文件组合 `ThreadStore` 与进程内 Thread pool，负责 create/read/list/resume/fork/archive/delete 以及
 * turn、Goal、Plan 操作。它不直接访问 JSONL、SQLite 或 lease 实现，且关闭后拒绝创建或恢复状态。
 */
import { createEntityId } from '../../ids.js';
import {
  AppServerError,
  type Goal,
  type ParsedClientParams,
  type Plan,
  type ThreadSnapshot,
  type ThreadSummary,
  type Turn,
  type UserInput,
} from '../../protocol/v1/index.js';
import { parseCursor } from '../../server/rpc/route.js';
import type { AgentFeature } from '../agent/index.js';

import { createForkRecords, filterSnapshot } from './fork.js';
import { projectThreadSnapshot } from './records.js';
import {
  assertSubscriptionListener,
  createThreadPool,
  createThreadState,
  type ServerRequestListener,
  type SubscriptionListener,
  type ThreadState,
} from './state.js';
import type {
  CreatedThreadData,
  LoadedThreadData,
  ThreadStore,
} from './store.js';
import type { ThreadTitleGenerator } from './title.js';
import type { TurnSettings } from './turns.js';

export interface CreateThreadsInput {
  readonly store: ThreadStore;
  readonly startAgentRun: AgentFeature['startRun'];
  readonly unloadGraceMs: number;
  readonly titleGenerator?: ThreadTitleGenerator;
  /**
   * 在 Thread Thread 用例 模块 中执行 `resolveInitialSettings` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `params`: `resolveInitialSettings` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 Thread Thread 用例 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread Thread 用例 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  resolveInitialSettings(
    params: ParsedClientParams<'thread/start'>,
  ): Promise<ThreadSnapshot['settings']>;
  /**
   * 在 Thread Thread 用例 模块 中执行 `resolveSettingsUpdate` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `snapshot`: `resolveSettingsUpdate` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `params`: `resolveSettingsUpdate` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 Thread Thread 用例 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread Thread 用例 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  resolveSettingsUpdate(
    snapshot: ThreadSnapshot,
    params: Omit<ParsedClientParams<'thread/settings/update'>, 'threadId'>,
  ): Promise<Partial<ThreadSnapshot['settings']>>;
}

export interface ThreadAttachment {
  readonly runtime: ThreadState;
  readonly snapshot: ThreadSnapshot;
}

/**
 * 创建进程级 Thread use cases。
 *
 * Args:
 * - `options.store`: JSONL、catalog 和 lease 的统一持久化边界。
 * - `options.startAgentRun`: turn 启动时调用的产品 Agent 入口。
 * - `options.unloadGraceMs`: 无订阅、无 operation 持有时延迟卸载的毫秒数。
 * - `options.titleGenerator`: completed turn 触发的可选标题生成能力。
 * - `options.resolveInitialSettings`: 创建 Thread 时解析完整 settings 的函数。
 * - `options.resolveSettingsUpdate`: 更新 settings 时校验并生成增量的函数。
 *
 * Returns:
 * - 返回进程关闭前共享同一 Thread pool 的完整 Thread feature。
 */
export function createThreads(options: CreateThreadsInput) {
  const pool = createThreadPool({
    store: options.store,
    startAgentRun: options.startAgentRun,
    unloadGraceMs: options.unloadGraceMs,
    ...(options.titleGenerator === undefined
      ? {}
      : { titleGenerator: options.titleGenerator }),
  });
  let stopping = false;

  const assertRunning = (): void => {
    if (stopping) {
      throw new AppServerError({
        type: 'threadBusy',
        message: 'Thread feature is stopping.',
      });
    }
  };

  const read = async (
    params: ParsedClientParams<'thread/read'>,
  ): Promise<ThreadSnapshot> => {
    const snapshot = projectThreadSnapshot(
      await options.store.read(params.threadId),
    );
    return filterSnapshot(snapshot, params.includeTurns, params.includeItems);
  };

  const feature = {
    initialize: () => options.store.initialize(),
    async start(
      connectionId: string,
      params: ParsedClientParams<'thread/start'>,
      listener?: SubscriptionListener,
      requestListener?: ServerRequestListener,
    ): Promise<ThreadAttachment> {
      assertRunning();
      assertSubscriptionListener(params.subscribe, listener);
      const threadId = createEntityId('thr');
      const settings = await options.resolveInitialSettings(params);
      const created = await options.store.create(threadId, {
        kind: 'thread.created',
        rootId: threadId,
        cwd: params.cwd,
        name: params.name,
        settings,
        metadata: params.metadata,
      });
      return registerCreatedState(
        created,
        threadId,
        connectionId,
        params.subscribe,
        listener,
        requestListener,
      );
    },
    async updateSettings(
      _connectionId: string,
      params: ParsedClientParams<'thread/settings/update'>,
    ): Promise<ThreadSnapshot['settings']> {
      return pool.withState(params.threadId, true, async (state) => {
        const snapshot = await state.snapshot();
        const update = await options.resolveSettingsUpdate(snapshot, {
          ...(params.mode === undefined ? {} : { mode: params.mode }),
          ...(params.profile === undefined ? {} : { profile: params.profile }),
          ...(params.model === undefined ? {} : { model: params.model }),
          ...(params.agent === undefined ? {} : { agent: params.agent }),
        });
        return state.updateSettings(update);
      });
    },
    async resume(
      connectionId: string,
      params: ParsedClientParams<'thread/resume'>,
      listener?: SubscriptionListener,
      requestListener?: ServerRequestListener,
    ): Promise<ThreadAttachment> {
      assertRunning();
      assertSubscriptionListener(params.subscribe, listener);
      const runtime = await pool.resume(
        params.threadId,
        connectionId,
        params.subscribe,
        listener,
        requestListener,
      );
      return { runtime, snapshot: await runtime.snapshot() };
    },
    read,
    async list(params: ParsedClientParams<'thread/list'>): Promise<{
      readonly data: ReadonlyArray<ThreadSummary>;
      readonly nextCursor?: string;
    }> {
      const offset = parseCursor(params.cursor);
      const page = options.store.list({
        archived: params.archived,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        offset,
        limit: params.limit,
      });
      const nextOffset = offset + page.data.length;
      return {
        data: page.data,
        ...(page.hasMore ? { nextCursor: String(nextOffset) } : {}),
      };
    },
    loaded: () => pool.loaded(),
    async fork(
      connectionId: string,
      params: ParsedClientParams<'thread/fork'>,
      listener?: SubscriptionListener,
      requestListener?: ServerRequestListener,
    ): Promise<ThreadAttachment> {
      assertRunning();
      assertSubscriptionListener(params.subscribe, listener);
      const source = await read({
        threadId: params.threadId,
        includeTurns: true,
        includeItems: true,
      });
      if (source.thread.archived) {
        throw new AppServerError({
          type: 'invalidParams',
          message: `Thread ${source.thread.id} must be unarchived before fork.`,
        });
      }
      const sourceRecords = await options.store.read(params.threadId);
      const threadId = createEntityId('thr');
      let created: CreatedThreadData | undefined;
      try {
        const records = await createForkRecords({
          threadId,
          source,
          sourceRecords,
          ...(params.lastTurnId === undefined
            ? {}
            : { lastTurnId: params.lastTurnId }),
          create: async () => {
            created = await options.store.create(threadId, {
              kind: 'thread.created',
              rootId: source.thread.rootId,
              forkedFromId: source.thread.id,
              cwd: source.thread.cwd,
              name: params.name ?? source.thread.name,
              settings: source.settings,
              metadata: {},
            });
            return created.record;
          },
          append: (record) => options.store.append(threadId, record),
        });
        if (created === undefined) {
          throw new Error(`Forked Thread ${threadId} was not created.`);
        }
        return registerCreatedState(
          { records, lease: created.lease },
          threadId,
          connectionId,
          params.subscribe,
          listener,
          requestListener,
        );
      } catch (error) {
        if (created !== undefined) await created.lease.release();
        throw error;
      }
    },
    startTurn(
      threadId: string,
      input: ReadonlyArray<UserInput>,
      settings?: TurnSettings,
    ): Promise<Turn> {
      return pool.withState(threadId, false, (state) =>
        state.startTurn(input, settings),
      );
    },
    steerTurn(
      threadId: string,
      turnId: string,
      input: ReadonlyArray<UserInput>,
    ): Promise<void> {
      return pool.withState(threadId, false, (state) =>
        state.steerTurn(turnId, input),
      );
    },
    interruptTurn(
      threadId: string,
      turnId: string,
      reason?: string,
    ): Promise<Turn> {
      return pool.withState(threadId, false, (state) =>
        state.interruptTurn(turnId, reason),
      );
    },
    async goal(threadId: string): Promise<Goal | null> {
      return (
        await read({
          threadId,
          includeTurns: false,
          includeItems: false,
        })
      ).goal;
    },
    setGoal(
      threadId: string,
      input: Parameters<ThreadState['setGoal']>[0],
    ): Promise<Goal> {
      return pool.withState(threadId, true, (state) => state.setGoal(input));
    },
    clearGoal(threadId: string): Promise<string> {
      return pool.withState(threadId, true, (state) => state.clearGoal());
    },
    async plan(threadId: string): Promise<Plan | null> {
      return (
        await read({
          threadId,
          includeTurns: false,
          includeItems: false,
        })
      ).plan;
    },
    setPlan(threadId: string, plan: Plan): Promise<Plan> {
      return pool.withState(threadId, true, (state) => state.setPlan(plan));
    },
    unsubscribe: (connectionId: string, threadId: string) =>
      pool.unsubscribe(connectionId, threadId),
    releaseConnection(connectionId: string): Promise<void> {
      pool.releaseConnection(connectionId);
      return Promise.resolve();
    },
    async archive(threadId: string) {
      const current = await read({
        threadId,
        includeTurns: true,
        includeItems: false,
      });
      if (current.thread.archived) {
        throw new AppServerError({
          type: 'invalidParams',
          message: `Thread ${threadId} is already archived.`,
        });
      }
      const result = await pool.withState(threadId, true, (state) =>
        state.archive(),
      );
      await pool.unloadNow(threadId);
      return result;
    },
    async unarchive(threadId: string) {
      return options.store.unarchive(threadId);
    },
    async delete(threadId: string): Promise<void> {
      await pool.unloadNow(threadId);
      await options.store.delete(threadId);
    },
    /**
     * 停止 Thread Thread 用例 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
     *
     * Args:
     * - 无：操作使用实例或闭包已经持有的稳定状态。
     *
     * Returns:
     * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
     *
     * Throws:
     * - 当 Thread Thread 用例 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
     */
    async close(): Promise<void> {
      if (stopping) return;
      stopping = true;
      await pool.close();
    },
  };

  async function registerCreatedState(
    loaded: LoadedThreadData,
    threadId: string,
    connectionId: string,
    subscribe: boolean,
    listener: SubscriptionListener | undefined,
    requestListener: ServerRequestListener | undefined,
  ): Promise<ThreadAttachment> {
    let runtime: ThreadState | undefined;
    try {
      runtime = createThreadState({
        records: loaded.records,
        store: options.store,
        startAgentRun: options.startAgentRun,
        lease: loaded.lease,
        ...(options.titleGenerator === undefined
          ? {}
          : { titleGenerator: options.titleGenerator }),
      });
      pool.register(
        threadId,
        runtime,
        connectionId,
        subscribe,
        listener,
        requestListener,
      );
      return { runtime, snapshot: await runtime.snapshot() };
    } catch (error) {
      if (runtime === undefined) await loaded.lease.release();
      else await runtime.close();
      throw error;
    }
  }

  return feature;
}

export type Threads = ReturnType<typeof createThreads>;
