/**
 * 已加载 Thread 的进程内状态、订阅集合与延迟卸载池。
 *
 * `ThreadState` 是普通对象；records、snapshot projector、permission session、active run 和 mutation queue
 * 只有一个所有者。`createThreadPool()` 通过闭包共享 loaded/loading map，确保同一 Thread 的并发 resume
 * 共用一次 lease 和一次状态构造。
 */
import { createEntityId } from '../../ids.js';
import { APP_SERVER_ERROR_CODES } from '../../protocol/errors.js';
import {
  AppServerError,
  type Goal,
  type PendingServerRequest,
  type Plan,
  type ServerNotification,
  type ThreadSnapshot,
  type ThreadSummary,
  type Turn,
  type UserInput,
} from '../../protocol/v1/index.js';
import type { ThreadLease } from '../../storage/threads/thread-lease.js';
import type {
  NewThreadRecord,
  ThreadRecord,
} from '../../storage/threads/thread-record.js';
import type { AgentFeature } from '../agent/index.js';
import { RulesStore } from '../tool/index.js';

import { compactionView } from './compact.js';
import { createThreadInteractions } from './interactions.js';
import { notificationsFor } from './notifications.js';
import { createThreadSnapshotProjection } from './records.js';
import type { ThreadArchiveMutation, ThreadStore } from './store.js';
import type { ThreadTitleGenerator } from './title.js';
import { createTurnOperations, type TurnSettings } from './turns.js';

/**
 * 执行 Thread 状态 模块 定义的 `SubscriptionListener` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `notification`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
 *
 * Returns:
 * - 返回 `SubscriptionListener` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export type SubscriptionListener = (
  notification: ServerNotification,
) => void | Promise<void>;

/**
 * 执行 Thread 状态 模块 定义的 `ServerRequestListener` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `request`: 进入 Thread 状态 模块 的稳定请求；校验后只读传递，不由函数修改。
 *
 * Returns:
 * - Promise 在 Thread 状态 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export type ServerRequestListener = (
  request: PendingServerRequest,
) => Promise<unknown>;

/** 当前 controller 的 RPC 连接已经不可用，pending request 仍属于 Thread 并等待其他连接接管。 */
export class ServerRequestControllerUnavailableError extends Error {
  override readonly name = 'ServerRequestControllerUnavailableError';

  /**
   * 把 route adapter 观察到的连接关闭转换为 Thread 内部调度信号。
   *
   * Args:
   * - `cause`: RPC peer 的明确断开错误；保留为 cause 供诊断，不用于完成 interaction。
   */
  constructor(cause: Error) {
    super(cause.message, { cause });
  }
}

interface Subscription {
  readonly notify: SubscriptionListener;
  readonly request?: ServerRequestListener;
}

export interface ThreadState {
  readonly id: string;
  readonly rootId: string;
  readonly cwd: string;
  readonly status: ThreadSnapshot['thread']['status'];
  /**
   * 读取 Thread 状态 模块 的 `snapshot` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  snapshot(): Promise<ThreadSnapshot>;
  /**
   * 执行 Thread 状态 模块 定义的 `subscribe` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `connectionId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `listener`: 生命周期内调用的回调；回调失败属于当前操作失败，不会被静默吞掉。
   * - `requestListener`: 生命周期内调用的回调；回调失败属于当前操作失败，不会被静默吞掉。
   *
   * Returns:
   * - 返回 `subscribe` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  subscribe(
    connectionId: string,
    listener: SubscriptionListener,
    requestListener?: ServerRequestListener,
  ): () => void;
  /**
   * 执行 Thread 状态 模块 定义的 `hasSubscriber` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `connectionId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
   */
  hasSubscriber(connectionId: string): boolean;
  readonly subscriberCount: number;
  /**
   * 执行 Thread 状态 模块 定义的 `hasActiveTurn` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
   */
  hasActiveTurn(): boolean;
  /**
   * 执行 Thread 状态 模块 定义的 `hasPendingServerRequest` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
   */
  hasPendingServerRequest(): boolean;
  /**
   * 持久化归档事实；成功返回前已完成 catalog 投影与订阅通知。
   *
   * Args:
   * - 无：归档当前状态拥有的 Thread。
   *
   * Returns:
   * - Promise 在 JSONL 与 catalog 提交后兑现为归档后的 summary 和对应 seq。
   *
   * Throws:
   * - Thread 已归档、存在 active turn、存在 pending request 或持久化失败时直接抛错。
   */
  archive(): Promise<ThreadArchiveMutation>;
  /**
   * 在 Thread 状态 模块 中执行 `startTurn` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `input`: `startTurn` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   * - `settings`: `startTurn` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 状态 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  startTurn(
    input: ReadonlyArray<UserInput>,
    settings?: TurnSettings,
  ): Promise<Turn>;
  /**
   * 执行 Thread 状态 模块 定义的 `steerTurn` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `turnId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `input`: `steerTurn` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  steerTurn(turnId: string, input: ReadonlyArray<UserInput>): Promise<void>;
  /**
   * 执行 Thread 状态 模块 定义的 `interruptTurn` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `turnId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `reason`: 可观察的终止或拒绝原因；会随失败状态向上游传播；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  interruptTurn(turnId: string, reason?: string): Promise<Turn>;
  /**
   * 在 Thread 状态 模块 中执行 `resolveServerRequest` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `requestId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `result`: 用于完成唯一待处理操作的结果；同一结果不得重复消费。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步副作用完整提交后兑现，不返回业务值。
   *
   * Throws:
   * - 当 Thread 状态 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  resolveServerRequest(requestId: string, result: unknown): Promise<void>;
  /**
   * 执行 Thread 状态 模块 定义的 `rejectServerRequest` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `requestId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `error`: 上游捕获的失败值；函数保留原始 cause 并转换为当前错误契约。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  rejectServerRequest(
    requestId: string,
    error: { readonly code: number; readonly message: string },
  ): Promise<void>;
  /**
   * 按 Thread 状态 模块 的一致性约束执行 `updateSettings` 状态变更。
   *
   * Args:
   * - `settings`: `updateSettings` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 状态 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  updateSettings(
    settings: Partial<ThreadSnapshot['settings']>,
  ): Promise<ThreadSnapshot['settings']>;
  /**
   * 按 Thread 状态 模块 的一致性约束执行 `setGoal` 状态变更。
   *
   * Args:
   * - `input`: `setGoal` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  setGoal(input: {
    readonly objective: string;
    readonly tokenBudget?: number;
    readonly status?: Goal['status'];
  }): Promise<Goal>;
  /**
   * 按 Thread 状态 模块 的一致性约束执行 `clearGoal` 状态变更。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  clearGoal(): Promise<string>;
  /**
   * 按 Thread 状态 模块 的一致性约束执行 `setPlan` 状态变更。
   *
   * Args:
   * - `plan`: `setPlan` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  setPlan(plan: Plan): Promise<Plan>;
  /**
   * 停止 Thread 状态 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 当 Thread 状态 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  close(): Promise<void>;
}

export interface CreateThreadStateInput {
  readonly records: ReadonlyArray<ThreadRecord>;
  readonly store: ThreadStore;
  readonly startAgentRun: AgentFeature['startRun'];
  readonly lease: ThreadLease;
  readonly titleGenerator?: ThreadTitleGenerator;
}

/**
 * 创建固定 Thread id 的进程内状态。
 *
 * Args:
 * - `options.records`: 已在 lease 保护下读取并通过 schema 校验的完整 record 序列。
 * - `options.store`: 该 Thread 唯一的 append 与 record subscription 边界。
 * - `options.startAgentRun`: 产品 Agent 的稳定运行入口。
 * - `options.lease`: 当前状态独占持有的 lease，直到 `close()` 完成后释放。
 * - `options.titleGenerator`: turn 完成后可异步生成标题的产品能力。
 *
 * Returns:
 * - 返回共享同一 projector、mutation queue、permission session 和 active turn 的普通对象。
 */
export function createThreadState(
  options: CreateThreadStateInput,
): ThreadState {
  const records = [...options.records];
  const projector = createThreadSnapshotProjection(records);
  const initial = projector.current();
  if (initial.thread.archived) {
    throw new AppServerError({
      type: 'invalidParams',
      message: `Thread ${initial.thread.id} must be unarchived before resume.`,
    });
  }
  const id = initial.thread.id;
  const rootId = initial.thread.rootId;
  const cwd = initial.thread.cwd;
  const rules = new RulesStore(cwd);
  const externalPaths = new Set<string>();
  const subscribers = new Map<string, Subscription>();
  const dispatchedServerRequests = new Set<string>();
  let rulesLoaded = false;
  let mutation: Promise<void> = Promise.resolve();
  let titleTask: Promise<void> | undefined;
  let titleAbortController: AbortController | undefined;
  let closing = false;

  const append = (record: NewThreadRecord): Promise<ThreadRecord> =>
    options.store.append(id, record);

  const enqueue = <TResult>(
    operation: () => Promise<TResult>,
  ): Promise<TResult> => {
    const result = mutation.then(operation);
    mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const assertOpen = (): void => {
    if (closing) {
      throw new AppServerError({
        type: 'threadBusy',
        message: `Thread ${id} is closing.`,
      });
    }
    if (projector.current().thread.archived) {
      throw new AppServerError({
        type: 'invalidParams',
        message: `Thread ${id} must be unarchived before modification.`,
      });
    }
  };

  const loadRules = async (): Promise<void> => {
    if (rulesLoaded) return;
    await rules.load();
    rulesLoaded = true;
  };

  const interactions = createThreadInteractions({
    rules,
    externalPaths,
    snapshot: () => projector.current(),
    append,
  });

  const scheduleTitleGeneration = (): void => {
    if (
      closing ||
      options.titleGenerator === undefined ||
      titleTask !== undefined ||
      projector.current().thread.name.trim() !== ''
    ) {
      return;
    }
    const controller = new AbortController();
    titleAbortController = controller;
    titleTask = options.titleGenerator
      .generate(projector.current(), controller.signal)
      .then(async (title) => {
        const name = title?.trim();
        if (
          name === undefined ||
          name === '' ||
          controller.signal.aborted ||
          closing
        ) {
          return;
        }
        await enqueue(async () => {
          if (
            controller.signal.aborted ||
            closing ||
            projector.current().thread.name.trim() !== ''
          ) {
            return;
          }
          await append({ kind: 'thread.metadata', name });
        });
      })
      .finally(() => {
        if (titleAbortController === controller) {
          titleTask = undefined;
          titleAbortController = undefined;
        }
      });
    // `close()` 仍会 await 原始 task 并收到同一错误；这里只避免异步标题任务在关闭前产生未处理拒绝告警。
    void titleTask.then(undefined, () => undefined);
  };

  const turns = createTurnOperations({
    threadId: id,
    startAgentRun: options.startAgentRun,
    permission: {
      rules: () => rules.rules(),
      externalPaths: () => [...externalPaths],
    },
    history: () => compactionView(records).projectedMessages,
    compactionEntries: () => compactionView(records).entries,
    prepareRun: loadRules,
    interactions,
    snapshot: () => projector.current(),
    append,
    enqueue,
    assertOpen,
    onCompleted: scheduleTitleGeneration,
  });

  const state: ThreadState = {
    id,
    rootId,
    cwd,
    get status() {
      return projector.current().thread.status;
    },
    snapshot: () => Promise.resolve(projector.current()),
    subscribe(connectionId, listener, requestListener) {
      if (subscribers.has(connectionId)) {
        throw new Error(`Connection ${connectionId} is already subscribed.`);
      }
      subscribers.set(connectionId, {
        notify: listener,
        ...(requestListener === undefined ? {} : { request: requestListener }),
      });
      if (requestListener !== undefined) {
        for (const request of projector.current().pendingServerRequests) {
          dispatchServerRequest(request);
        }
      }
      return () => subscribers.delete(connectionId);
    },
    hasSubscriber: (connectionId) => subscribers.has(connectionId),
    get subscriberCount() {
      return subscribers.size;
    },
    hasActiveTurn: () => turns.hasActiveTurn(),
    hasPendingServerRequest: () =>
      projector.current().pendingServerRequests.length > 0,
    archive() {
      return enqueue(async () => {
        assertOpen();
        if (
          turns.hasActiveTurn() ||
          projector.current().pendingServerRequests.length > 0
        ) {
          throw new AppServerError({
            type: 'threadBusy',
            message: `Thread ${id} cannot be archived while work is active.`,
          });
        }
        return options.store.archive(id);
      });
    },
    startTurn: (input, settings) => turns.start(input, settings),
    steerTurn: (turnId, input) => turns.steer(turnId, input),
    interruptTurn: (turnId, reason) =>
      turns.interrupt(turnId, reason ?? 'client request'),
    resolveServerRequest: (requestId, result) =>
      turns.resolveServerRequest(requestId, result),
    rejectServerRequest: (requestId, error) =>
      turns.rejectServerRequest(requestId, error),
    updateSettings(settings) {
      return enqueue(async () => {
        assertOpen();
        const next = { ...projector.current().settings, ...settings };
        await append({ kind: 'thread.metadata', settings: next });
        return next;
      });
    },
    setGoal(input) {
      return enqueue(async () => {
        assertOpen();
        const objective = input.objective.trim();
        if (objective.length === 0 || objective.length > 4_000) {
          throw new AppServerError({
            type: 'invalidParams',
            message: 'Goal objective must contain 1 to 4000 characters.',
          });
        }
        const current = projector.current().goal;
        const now = new Date().toISOString();
        const goal: Goal = {
          id: current?.id ?? createEntityId('job'),
          objective,
          status: input.status ?? current?.status ?? 'active',
          ...(input.tokenBudget === undefined
            ? current?.tokenBudget === undefined
              ? {}
              : { tokenBudget: current.tokenBudget }
            : { tokenBudget: input.tokenBudget }),
          tokensUsed: current?.tokensUsed ?? 0,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        };
        await append({ kind: 'goal.state', goal });
        return goal;
      });
    },
    clearGoal() {
      return enqueue(async () => {
        assertOpen();
        const current = projector.current().goal;
        if (current === null) {
          throw new AppServerError({
            type: 'invalidParams',
            message: `Thread ${id} has no goal.`,
          });
        }
        await append({ kind: 'goal.state', goal: null, goalId: current.id });
        return current.id;
      });
    },
    setPlan(plan) {
      return enqueue(async () => {
        assertOpen();
        if (plan.threadId !== id) {
          throw new AppServerError({
            type: 'turnMismatch',
            message: `Plan belongs to ${plan.threadId}, expected ${id}.`,
          });
        }
        await append({ kind: 'plan.state', plan });
        return plan;
      });
    },
    /**
     * 停止 Thread 状态 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
     *
     * Args:
     * - 无：操作使用实例或闭包已经持有的稳定状态。
     *
     * Returns:
     * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
     *
     * Throws:
     * - 当 Thread 状态 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
     */
    async close() {
      if (closing) return;
      closing = true;
      titleAbortController?.abort('thread runtime closing');
      await turns.close();
      await mutation;
      await titleTask;
      await mutation;
      subscribers.clear();
      stopRecordListener();
      await options.lease.release();
    },
  };

  const publish = (notification: ServerNotification): void => {
    for (const [connectionId, subscription] of subscribers) {
      void Promise.resolve(subscription.notify(notification)).then(
        undefined,
        () => {
          // 通知发送失败表示该连接已不可用；移除订阅，避免后续 record 持续写向失效 transport。
          subscribers.delete(connectionId);
        },
      );
    }
  };

  const requestWithFailover = async (
    request: PendingServerRequest,
  ): Promise<ServerRequestDispatchResult> => {
    const attempted = new Set<Subscription>();
    let lastError: unknown;
    let hasControllerFailure = false;
    while (true) {
      const subscription = [...subscribers.values()].find(
        (candidate) =>
          candidate.request !== undefined && !attempted.has(candidate),
      );
      if (subscription === undefined) {
        if (hasControllerFailure) throw lastError;
        return { type: 'controllerUnavailable' };
      }
      attempted.add(subscription);
      const requestListener = subscription.request;
      if (requestListener === undefined) {
        throw new Error('Selected subscription has no request listener.');
      }
      try {
        return {
          type: 'resolved',
          result: await requestListener(request),
        };
      } catch (error) {
        if (error instanceof ServerRequestControllerUnavailableError) {
          continue;
        }
        hasControllerFailure = true;
        lastError = error;
      }
    }
  };

  function dispatchServerRequest(request: PendingServerRequest): void {
    if (dispatchedServerRequests.has(request.id)) return;
    if (
      ![...subscribers.values()].some((entry) => entry.request !== undefined)
    ) {
      return;
    }
    dispatchedServerRequests.add(request.id);
    const task = requestWithFailover(request)
      .then(
        (result) => {
          switch (result.type) {
            case 'resolved':
              return state.resolveServerRequest(request.id, result.result);
            case 'controllerUnavailable':
              return undefined;
            default:
              result satisfies never;
              throw new Error('Unknown Server Request dispatch result.');
          }
        },
        (error: unknown) =>
          state.rejectServerRequest(request.id, serverRequestError(error)),
      )
      .finally(() => dispatchedServerRequests.delete(request.id));
    // resolution/rejection 已写回 Thread；observer 只覆盖持久化阶段自身的失败，避免 detached task 触发进程告警。
    void task.then(undefined, () => undefined);
  }

  const applyPersistedRecord = (record: ThreadRecord): void => {
    const expectedSeq = projector.current().seq + 1;
    if (record.threadId !== id || record.seq !== expectedSeq) {
      throw new AppServerError({
        type: 'storageCorrupt',
        message: `Thread ${id} received persisted seq ${record.seq}, expected ${expectedSeq}.`,
      });
    }
    records.push(record);
    projector.apply(record);
    for (const notification of notificationsFor(record, projector.current())) {
      publish(notification);
    }
    if (record.kind === 'serverRequest.created') {
      dispatchServerRequest(record.request);
    }
  };

  const stopRecordListener = options.store.subscribe(id, applyPersistedRecord);
  return state;
}

type ServerRequestDispatchResult =
  | { readonly type: 'resolved'; readonly result: unknown }
  | { readonly type: 'controllerUnavailable' };

function serverRequestError(error: unknown): {
  readonly code: number;
  readonly message: string;
} {
  if (error instanceof AppServerError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: APP_SERVER_ERROR_CODES.internal,
    message:
      error instanceof Error
        ? error.message
        : `Server Request controller threw a non-Error value: ${String(error)}`,
  };
}

interface ThreadEntry {
  readonly state: ThreadState;
  readonly subscriptions: Map<string, () => void>;
  holds: number;
  unloadTimer: NodeJS.Timeout | undefined;
}

export interface ThreadPool {
  /**
   * 构造 Thread 状态 模块 中的 `register` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `state`: `register` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `connectionId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `subscribe`: `register` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `listener`: 生命周期内调用的回调；回调失败属于当前操作失败，不会被静默吞掉。
   * - `requestListener`: 生命周期内调用的回调；回调失败属于当前操作失败，不会被静默吞掉。
   *
   * Returns:
   * - Thread 状态 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  register(
    threadId: string,
    state: ThreadState,
    connectionId: string,
    subscribe: boolean,
    listener: SubscriptionListener | undefined,
    requestListener: ServerRequestListener | undefined,
  ): void;
  /**
   * 校验恢复结果并继续 Thread 状态 模块 中唯一处于等待状态的执行。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `connectionId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `subscribe`: `resume` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `listener`: 生命周期内调用的回调；回调失败属于当前操作失败，不会被静默吞掉。
   * - `requestListener`: 生命周期内调用的回调；回调失败属于当前操作失败，不会被静默吞掉。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  resume(
    threadId: string,
    connectionId: string,
    subscribe: boolean,
    listener: SubscriptionListener | undefined,
    requestListener: ServerRequestListener | undefined,
  ): Promise<ThreadState>;
  /**
   * 读取 Thread 状态 模块 的 `loaded` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 状态 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  loaded(): Promise<ReadonlyArray<ThreadSummary>>;
  /**
   * 执行 Thread 状态 模块 定义的 `unsubscribe` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `connectionId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  unsubscribe(connectionId: string, threadId: string): Promise<void>;
  /**
   * 执行 Thread 状态 模块 定义的 `releaseConnection` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `connectionId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Thread 状态 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  releaseConnection(connectionId: string): void;
  /**
   * 执行 Thread 状态 模块 定义的 `withState` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `allowLoad`: `withState` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `operation`: `withState` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  withState<TResult>(
    threadId: string,
    allowLoad: boolean,
    operation: (state: ThreadState) => Promise<TResult>,
  ): Promise<TResult>;
  /**
   * 执行 Thread 状态 模块 定义的 `unloadNow` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 Thread 状态 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  unloadNow(threadId: string): Promise<void>;
  /**
   * 停止 Thread 状态 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 当 Thread 状态 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  close(): Promise<void>;
}

/**
 * 创建共享已加载 Thread 的进程内池。
 *
 * Args:
 * - `options.store`: load 时取得 records 与 lease 的唯一持久化入口。
 * - `options.startAgentRun`: 新建 ThreadState 时注入的产品 Agent 入口。
 * - `options.unloadGraceMs`: 无订阅且无持有者后等待卸载的毫秒数。
 * - `options.titleGenerator`: 新建 ThreadState 时使用的可选标题生成器。
 *
 * Returns:
 * - 返回通过闭包持有 loaded/loading map、引用计数、订阅解绑和 unload timer 的池。
 */
export function createThreadPool(options: {
  readonly store: ThreadStore;
  readonly startAgentRun: AgentFeature['startRun'];
  readonly unloadGraceMs: number;
  readonly titleGenerator?: ThreadTitleGenerator;
}): ThreadPool {
  const entries = new Map<string, ThreadEntry>();
  const loading = new Map<string, Promise<ThreadEntry>>();
  let closing = false;

  const attach = (
    entry: ThreadEntry,
    connectionId: string,
    subscribe: boolean,
    listener: SubscriptionListener | undefined,
    requestListener: ServerRequestListener | undefined,
  ): void => {
    if (!subscribe) return;
    assertSubscriptionListener(subscribe, listener);
    if (entry.unloadTimer !== undefined) {
      clearTimeout(entry.unloadTimer);
      entry.unloadTimer = undefined;
    }
    if (entry.subscriptions.has(connectionId)) return;
    entry.subscriptions.set(
      connectionId,
      entry.state.subscribe(connectionId, listener, requestListener),
    );
  };

  const requireLoaded = (threadId: string): ThreadEntry => {
    const entry = entries.get(threadId);
    if (entry === undefined) {
      throw new AppServerError({
        type: 'threadNotFound',
        message: `Thread ${threadId} is not loaded; call thread/resume first.`,
      });
    }
    return entry;
  };

  const unloadNow = async (threadId: string): Promise<void> => {
    const entry = entries.get(threadId);
    if (entry === undefined) return;
    if (
      entry.holds > 0 ||
      entry.state.hasActiveTurn() ||
      entry.state.hasPendingServerRequest()
    ) {
      throw new AppServerError({
        type: 'threadBusy',
        message: `Thread ${threadId} cannot unload while work is active.`,
      });
    }
    entries.delete(threadId);
    if (entry.unloadTimer !== undefined) clearTimeout(entry.unloadTimer);
    await entry.state.close();
  };

  const scheduleUnload = (threadId: string, entry: ThreadEntry): void => {
    if (
      entry.subscriptions.size > 0 ||
      entry.holds > 0 ||
      entry.unloadTimer !== undefined
    ) {
      return;
    }
    entry.unloadTimer = setTimeout(() => {
      entry.unloadTimer = undefined;
      void unloadNow(threadId).catch(() => {
        const current = entries.get(threadId);
        if (!closing && current === entry) scheduleUnload(threadId, entry);
      });
    }, options.unloadGraceMs);
  };

  const loadOnce = async (threadId: string): Promise<ThreadEntry> => {
    const loaded = await options.store.load(threadId);
    try {
      const state = createThreadState({
        records: loaded.records,
        store: options.store,
        startAgentRun: options.startAgentRun,
        lease: loaded.lease,
        ...(options.titleGenerator === undefined
          ? {}
          : { titleGenerator: options.titleGenerator }),
      });
      const entry: ThreadEntry = {
        state,
        subscriptions: new Map(),
        holds: 0,
        unloadTimer: undefined,
      };
      entries.set(threadId, entry);
      scheduleUnload(threadId, entry);
      return entry;
    } catch (error) {
      await loaded.lease.release();
      throw error;
    }
  };

  const load = async (threadId: string): Promise<ThreadEntry> => {
    const loaded = entries.get(threadId);
    if (loaded !== undefined) return loaded;
    const activeLoad = loading.get(threadId);
    if (activeLoad !== undefined) return activeLoad;
    const task = loadOnce(threadId);
    loading.set(threadId, task);
    try {
      return await task;
    } finally {
      loading.delete(threadId);
    }
  };

  return {
    register(
      threadId,
      state,
      connectionId,
      subscribe,
      listener,
      requestListener,
    ) {
      if (entries.has(threadId)) {
        throw new Error(`Thread state ${threadId} is already registered.`);
      }
      const entry: ThreadEntry = {
        state,
        subscriptions: new Map(),
        holds: 0,
        unloadTimer: undefined,
      };
      entries.set(threadId, entry);
      attach(entry, connectionId, subscribe, listener, requestListener);
      scheduleUnload(threadId, entry);
    },
    async resume(threadId, connectionId, subscribe, listener, requestListener) {
      const entry = await load(threadId);
      attach(entry, connectionId, subscribe, listener, requestListener);
      scheduleUnload(threadId, entry);
      return entry.state;
    },
    loaded: () =>
      Promise.all(
        [...entries.values()].map(
          async (entry) => (await entry.state.snapshot()).thread,
        ),
      ),
    async unsubscribe(connectionId, threadId) {
      const entry = entries.get(threadId);
      if (entry === undefined) return;
      const unsubscribe = entry.subscriptions.get(connectionId);
      if (unsubscribe !== undefined) unsubscribe();
      entry.subscriptions.delete(connectionId);
      scheduleUnload(threadId, entry);
    },
    releaseConnection(connectionId) {
      for (const [threadId, entry] of entries) {
        const unsubscribe = entry.subscriptions.get(connectionId);
        if (unsubscribe === undefined) continue;
        unsubscribe();
        entry.subscriptions.delete(connectionId);
        scheduleUnload(threadId, entry);
      }
    },
    async withState(threadId, allowLoad, operation) {
      const entry = allowLoad ? await load(threadId) : requireLoaded(threadId);
      if (entry.unloadTimer !== undefined) {
        clearTimeout(entry.unloadTimer);
        entry.unloadTimer = undefined;
      }
      entry.holds += 1;
      try {
        return await operation(entry.state);
      } finally {
        entry.holds -= 1;
        scheduleUnload(threadId, entry);
      }
    },
    unloadNow,
    /**
     * 停止 Thread 状态 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
     *
     * Args:
     * - 无：操作使用实例或闭包已经持有的稳定状态。
     *
     * Returns:
     * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
     *
     * Throws:
     * - 当 Thread 状态 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
     */
    async close() {
      if (closing) return;
      closing = true;
      const loaded = [...entries.values()];
      entries.clear();
      await Promise.all(
        loaded.map(async (entry) => {
          if (entry.unloadTimer !== undefined) clearTimeout(entry.unloadTimer);
          await entry.state.close();
        }),
      );
    },
  };
}

/**
 * 校验订阅参数与 listener 是否成对出现。
 *
 * Args:
 * - `subscribe`: protocol 请求是否声明订阅。
 * - `listener`: 当前 connection 提供的 notification listener。
 *
 * Returns:
 * - 校验成功后把 listener narrowing 为可调用函数；未订阅时不改变值。
 *
 * Throws:
 * - 请求订阅但 connection 未提供 listener 时抛出 `invalidParams`。
 */
export function assertSubscriptionListener(
  subscribe: boolean,
  listener: SubscriptionListener | undefined,
): asserts listener is SubscriptionListener {
  if (subscribe && listener === undefined) {
    throw new AppServerError({
      type: 'invalidParams',
      message: 'Subscribed thread requires a connection listener.',
    });
  }
}
