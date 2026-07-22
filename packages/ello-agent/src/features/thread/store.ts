/**
 * Thread JSONL、查询投影和 lease 的统一持久化边界。
 *
 * 调用方只通过 `ThreadStore` 创建、加载、追加、归档和删除 Thread。append 在 JSONL 成功后同步推进
 * catalog；已加载 Thread 的 record listener 会在 catalog 更新后收到同一条 record，确保 snapshot 与通知
 * 不会先于持久化查询投影。
 */
import type { CodingDatabase } from '../../infra/database/database.js';
import {
  AppServerError,
  type ThreadItem,
  type ThreadSnapshot,
  type ThreadSummary,
  type Turn,
} from '../../protocol/v1/index.js';
import {
  ThreadLeaseStore,
  type ThreadLease,
} from '../../storage/threads/thread-lease.js';
import { ThreadLogStore } from '../../storage/threads/thread-log.js';
import type {
  NewThreadRecord,
  ThreadRecord,
} from '../../storage/threads/thread-record.js';

import {
  createThreadCatalog,
  type ThreadCatalogListOptions,
  type ThreadCatalogPage,
  type ThreadCatalogProjection,
} from './catalog-store.js';
import { projectThreadSnapshot } from './records.js';

export interface ThreadStore {
  /**
   * 初始化 Thread 持久化 store 模块 所需的目录、连接或缓存；完成前不得使用依赖这些资源的操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在依赖资源全部可用后兑现；兑现前实例仍视为未就绪。
   *
   * Throws:
   * - 当 Thread 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  initialize(): Promise<void>;
  /**
   * 构造 Thread 持久化 store 模块 中的 `create` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `record`: 要由 `create` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - Promise 在 Thread 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  create(
    threadId: string,
    record: Extract<NewThreadRecord, { readonly kind: 'thread.created' }>,
  ): Promise<CreatedThreadData>;
  /**
   * 读取 Thread 持久化 store 模块 的 `load` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 Thread 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  load(threadId: string): Promise<LoadedThreadData>;
  /**
   * 读取 Thread 持久化 store 模块 的 `read` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 Thread 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  read(threadId: string): Promise<ReadonlyArray<ThreadRecord>>;
  /**
   * 读取 Thread 持久化 store 模块 的 `readArchived` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 Thread 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  readArchived(threadId: string): Promise<ReadonlyArray<ThreadRecord>>;
  /**
   * 按 Thread 持久化 store 模块 的一致性约束执行 `append` 状态变更。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `record`: 要由 `append` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - Promise 在 Thread 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  append(threadId: string, record: NewThreadRecord): Promise<ThreadRecord>;
  /**
   * 执行 Thread 持久化 store 模块 定义的 `subscribe` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `listener`: 生命周期内调用的回调；回调失败属于当前操作失败，不会被静默吞掉。
   *
   * Returns:
   * - 返回 `subscribe` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  subscribe(
    threadId: string,
    listener: (record: ThreadRecord) => void,
  ): () => void;
  /**
   * 读取 Thread 持久化 store 模块 的 `list` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `options`: 仅作用于 `list` 的调用选项；函数只读取该对象，不保留可变引用。
   *
   * Returns:
   * - 返回 `list` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  list(options: ThreadCatalogListOptions): ThreadCatalogPage;
  /**
   * 按 Thread 持久化 store 模块 的一致性约束执行 `archive` 状态变更。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 Thread 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  archive(threadId: string): Promise<ThreadSummary>;
  /**
   * 按 Thread 持久化 store 模块 的一致性约束执行 `unarchive` 状态变更。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 Thread 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  unarchive(threadId: string): Promise<ThreadSummary>;
  /**
   * 按 Thread 持久化 store 模块 的一致性约束执行 `delete` 状态变更。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 Thread 持久化 store 模块 的异步副作用完整提交后兑现，不返回业务值。
   *
   * Throws:
   * - 当 Thread 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  delete(threadId: string): Promise<void>;
}

export interface LoadedThreadData {
  readonly records: ReadonlyArray<ThreadRecord>;
  readonly lease: ThreadLease;
}

export interface CreatedThreadData extends LoadedThreadData {
  readonly record: ThreadRecord;
}

/**
 * 创建进程级 Thread 持久化对象。
 *
 * Args:
 * - `input.root`: Thread JSONL 与 lease 文件所在的数据根目录。
 * - `input.database`: catalog 投影使用的已打开数据库；生命周期仍由 composition root 管理。
 *
 * Returns:
 * - 返回统一协调 JSONL、catalog 与 lease 的 `ThreadStore`；同一 store 内每个 Thread 最多一个 listener。
 */
export function createThreadStore(input: {
  readonly root: string;
  readonly database: CodingDatabase;
}): ThreadStore {
  const logs = new ThreadLogStore({ root: input.root });
  const catalog = createThreadCatalog(input.database);
  const leases = new ThreadLeaseStore(input.root);
  const subscribed = new Set<string>();

  const append = async (
    threadId: string,
    record: NewThreadRecord,
  ): Promise<ThreadRecord> => {
    const persisted = await logs.append(threadId, record);
    if (!subscribed.has(threadId)) catalog.apply(persisted);
    return persisted;
  };

  return {
    /**
     * 初始化 Thread 持久化 store 模块 所需的目录、连接或缓存；完成前不得使用依赖这些资源的操作。
     *
     * Args:
     * - 无：操作使用实例或闭包已经持有的稳定状态。
     *
     * Returns:
     * - Promise 在依赖资源全部可用后兑现；兑现前实例仍视为未就绪。
     *
     * Throws:
     * - 当 Thread 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
     */
    async initialize() {
      await logs.initialize();
      const activeThreadIds = await recoverInterruptedThreads({ logs, leases });
      await reconcileThreadCatalog({ logs, catalog, activeThreadIds });
    },
    async create(threadId, record) {
      const lease = await leases.acquire(threadId);
      try {
        const created = await logs.create(threadId, record);
        catalog.apply(created);
        return { record: created, records: [created], lease };
      } catch (error) {
        await lease.release();
        throw error;
      }
    },
    async load(threadId) {
      const lease = await leases.acquire(threadId);
      try {
        return { records: await logs.read(threadId), lease };
      } catch (error) {
        await lease.release();
        throw error;
      }
    },
    read: (threadId) => logs.read(threadId),
    readArchived: (threadId) => logs.readArchived(threadId),
    append,
    subscribe(threadId, listener) {
      if (subscribed.has(threadId)) {
        throw new Error(`Thread ${threadId} already has a store listener.`);
      }
      subscribed.add(threadId);
      const stop = logs.subscribe(threadId, (record) => {
        catalog.apply(record);
        listener(record);
      });
      return () => {
        stop();
        subscribed.delete(threadId);
      };
    },
    list: (options) => catalog.list(options),
    async archive(threadId) {
      await append(threadId, {
        kind: 'thread.metadata',
        archived: true,
      });
      await logs.archive(threadId);
      return projectSummary(await logs.readArchived(threadId));
    },
    async unarchive(threadId) {
      await logs.unarchive(threadId);
      await append(threadId, {
        kind: 'thread.metadata',
        archived: false,
      });
      return projectSummary(await logs.read(threadId));
    },
    async delete(threadId) {
      if (await logs.exists(threadId, false)) {
        await logs.delete(threadId, false);
      } else if (await logs.exists(threadId, true)) {
        await logs.delete(threadId, true);
      } else {
        throw new AppServerError({
          type: 'threadNotFound',
          message: `Thread ${threadId} does not exist.`,
        });
      }
      if (!catalog.delete(threadId)) {
        throw new Error(
          `Thread catalog ${threadId} disappeared before delete.`,
        );
      }
    },
  };
}

function projectSummary(records: ReadonlyArray<ThreadRecord>): ThreadSummary {
  return projectThreadSnapshot(records).thread;
}

async function recoverInterruptedThreads(options: {
  readonly logs: ThreadLogStore;
  readonly leases: ThreadLeaseStore;
}): Promise<ReadonlySet<string>> {
  const activeThreadIds = new Set<string>();
  const threadIds = await options.logs.listThreadIds(false);
  for (const threadId of threadIds) {
    const lease = await options.leases.tryAcquire(threadId);
    if (lease === undefined) {
      activeThreadIds.add(threadId);
      continue;
    }
    try {
      const snapshot = projectThreadSnapshot(await options.logs.read(threadId));
      const preview = recoverablePreview(snapshot);
      if (preview !== undefined) {
        await options.logs.append(threadId, {
          kind: 'thread.metadata',
          preview,
        });
      }
      const activeTurns = snapshot.turns.filter(
        (turn) => turn.status === 'inProgress',
      );
      for (const turn of activeTurns) {
        for (const item of turn.items) {
          const interrupted = interruptItem(item);
          if (interrupted === null) continue;
          await options.logs.append(threadId, {
            kind: 'item.completed',
            turnId: turn.id,
            item: interrupted,
          });
        }
        await options.logs.append(threadId, {
          kind: 'turn.interrupted',
          turn: interruptedTurn(turn),
          reason: 'server restarted before the turn reached a terminal state',
        });
      }
      for (const request of snapshot.pendingServerRequests) {
        await options.logs.append(threadId, {
          kind: 'serverRequest.resolved',
          requestId: request.id,
          turnId: request.turnId,
          itemId: request.itemId,
          resolution: 'cancelledByRestart',
        });
      }
      if (activeTurns.length > 0 || snapshot.pendingServerRequests.length > 0) {
        await options.logs.append(threadId, {
          kind: 'thread.status',
          status: 'interrupted',
          activeFlags: [],
        });
      }
    } finally {
      await lease.release();
    }
  }
  return activeThreadIds;
}

function recoverablePreview(snapshot: ThreadSnapshot): string | undefined {
  if (snapshot.thread.preview.trim() !== '') return undefined;
  for (const turn of snapshot.turns) {
    const message = turn.items.find((item) => item.type === 'userMessage');
    if (message?.type !== 'userMessage') continue;
    const preview = message.text.trim().replace(/\s+/gu, ' ').slice(0, 500);
    if (preview !== '') return preview;
  }
  return undefined;
}

function interruptedTurn(turn: Turn): Turn {
  return {
    ...turn,
    status: 'interrupted',
    items: [],
    completedAt: new Date().toISOString(),
    errorCode: 'SERVER_RESTARTED',
  };
}

function interruptItem(item: ThreadItem): ThreadItem | null {
  switch (item.type) {
    case 'userMessage':
    case 'notice':
    case 'error':
      return null;
    case 'agentMessage':
    case 'reasoning':
    case 'plan':
    case 'commandExecution':
    case 'fileChange':
    case 'toolCall':
    case 'subagent':
    case 'contextCompaction':
      return item.status === 'inProgress'
        ? { ...item, status: 'failed' }
        : null;
    default:
      item satisfies never;
      throw new Error(`Unhandled Thread item: ${String(item)}`);
  }
}

async function reconcileThreadCatalog(options: {
  readonly logs: ThreadLogStore;
  readonly catalog: ThreadCatalogProjection;
  readonly activeThreadIds: ReadonlySet<string>;
}): Promise<void> {
  const [activeIds, archivedIds] = await Promise.all([
    options.logs.listThreadIds(false),
    options.logs.listThreadIds(true),
  ]);
  const logIds = new Set<string>();
  for (const [archived, ids] of [
    [false, activeIds],
    [true, archivedIds],
  ] as const) {
    for (const threadId of ids) {
      if (logIds.has(threadId)) {
        throw new AppServerError({
          type: 'storageCorrupt',
          message: `Thread ${threadId} has both active and archived logs.`,
        });
      }
      logIds.add(threadId);
      if (!archived && options.activeThreadIds.has(threadId)) continue;
      const records = archived
        ? await options.logs.readArchived(threadId)
        : await options.logs.read(threadId);
      const snapshot = projectThreadSnapshot(records);
      const state = options.catalog.state(threadId);
      if (
        state === null ||
        state.seq !== snapshot.seq ||
        state.archived !== snapshot.thread.archived
      ) {
        options.catalog.rebuild(records);
      }
    }
  }
  for (const state of options.catalog.states()) {
    if (!logIds.has(state.id)) options.catalog.delete(state.id);
  }
}
