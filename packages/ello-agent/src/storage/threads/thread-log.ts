/**
 * 本文件负责持久化层的“thread-log”模块职责。
 *
 * 文件、lease 或 record 状态由显式 store 入口拥有；读取结果在离开边界前完成结构校验。
 * 写入顺序、连续序号和资源释放是持久化不变量，损坏数据与非法状态直接失败。
 */
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { errnoCode } from '../../infra/filesystem.js';
import {
  activeThreadsDir,
  archivedThreadLogPath,
  archivedThreadsDir,
  threadLogPath,
} from '../../infra/paths.js';
import { AppServerError } from '../../protocol/errors.js';

import {
  parseThreadRecord,
  type NewThreadRecord,
  type ThreadRecord,
} from './thread-record.js';

export interface ThreadLogStoreOptions {
  readonly root: string;
}

interface WriterState {
  nextSeq: number;
  queue: Promise<void>;
}

/**
 * 执行 持久化层的 `thread-log` 模块 定义的 `ThreadRecordListener` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `record`: 要由 `ThreadRecordListener` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 持久化层的 `thread-log` 模块 的同步状态变更完成后返回，不产生业务结果。
 */
export type ThreadRecordListener = (record: ThreadRecord) => void;

/**
 * Thread JSONL 的唯一写入口。每个 thread 有独立 Promise 队列，不同 thread 可并行。
 */
export class ThreadLogStore {
  private readonly root: string;
  private readonly writers = new Map<string, WriterState>();
  private readonly listeners = new Map<string, ThreadRecordListener>();

  /**
   * 创建 `ThreadLogStore`，由该实例独占 持久化层的 `thread-log` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `options`: 仅作用于 `constructor ThreadLogStore` 的调用选项；函数只读取该对象，不保留可变引用。
   */
  constructor(options: ThreadLogStoreOptions) {
    this.root = options.root;
  }

  /**
   * 初始化 持久化层的 `thread-log` 模块 所需的目录、连接或缓存；完成前不得使用依赖这些资源的操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在依赖资源全部可用后兑现；兑现前实例仍视为未就绪。
   *
   * Throws:
   * - 当 持久化层的 `thread-log` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(activeThreadsDir(this.root), { recursive: true }),
      mkdir(archivedThreadsDir(this.root), { recursive: true }),
    ]);
  }

  /**
   * 构造 持久化层的 `thread-log` 模块 中的 `create` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `record`: 要由 `create` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - Promise 在 持久化层的 `thread-log` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 持久化层的 `thread-log` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async create(
    threadId: string,
    record: Extract<NewThreadRecord, { readonly kind: 'thread.created' }>,
  ): Promise<ThreadRecord> {
    await this.initialize();
    const fullRecord = parseThreadRecord(
      {
        ...record,
        schema: 1,
        seq: 1,
        threadId,
        createdAt: new Date().toISOString(),
      },
      `${threadId}:create`,
    );
    const path = threadLogPath(threadId, this.root);
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(fullRecord)}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        throw new AppServerError({
          type: 'threadBusy',
          message: `Thread ${threadId} already exists.`,
          cause: error,
        });
      }
      throw error;
    } finally {
      await handle?.close();
    }
    this.writers.set(threadId, { nextSeq: 2, queue: Promise.resolve() });
    return fullRecord;
  }

  /**
   * 按 持久化层的 `thread-log` 模块 的一致性约束执行 `append` 状态变更。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `record`: 要由 `append` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - Promise 在 持久化层的 `thread-log` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 持久化层的 `thread-log` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  append(threadId: string, record: NewThreadRecord): Promise<ThreadRecord> {
    const task = this.appendQueued(threadId, record);
    // 队列必须继续可用；当前调用仍会拿到原始 rejection。
    void task.then(undefined, () => undefined);
    return task;
  }

  /**
   * runtime 订阅同一 JSONL writer 的提交结果，保证 transcript 与领域事件严格按
   * 已落盘 seq 更新 snapshot/SQLite；一个 thread 同时只能有一个 runtime owner。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `listener`: 生命周期内调用的回调；回调失败属于当前操作失败，不会被静默吞掉。
   *
   * Returns:
   * - 返回 `subscribe` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  subscribe(threadId: string, listener: ThreadRecordListener): () => void {
    if (this.listeners.has(threadId)) {
      throw new Error(`Thread log ${threadId} already has a runtime listener.`);
    }
    this.listeners.set(threadId, listener);
    return () => {
      if (this.listeners.get(threadId) === listener) {
        this.listeners.delete(threadId);
      }
    };
  }

  /**
   * 读取 持久化层的 `thread-log` 模块 的 `read` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 持久化层的 `thread-log` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 持久化层的 `thread-log` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async read(threadId: string): Promise<readonly ThreadRecord[]> {
    // 读请求必须观察同一 writer 已提交的完整 JSONL，不能读取正在追加的最后一行。
    await this.flush(threadId);
    return this.readPath(threadLogPath(threadId, this.root), threadId);
  }

  /**
   * 读取 持久化层的 `thread-log` 模块 的 `readArchived` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 持久化层的 `thread-log` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 持久化层的 `thread-log` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async readArchived(threadId: string): Promise<readonly ThreadRecord[]> {
    await this.flush(threadId);
    return this.readPath(archivedThreadLogPath(threadId, this.root), threadId);
  }

  /**
   * 按 持久化层的 `thread-log` 模块 的一致性约束执行 `archive` 状态变更。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 持久化层的 `thread-log` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async archive(threadId: string): Promise<void> {
    await this.flush(threadId);
    await mkdir(archivedThreadsDir(this.root), { recursive: true });
    await rename(
      threadLogPath(threadId, this.root),
      archivedThreadLogPath(threadId, this.root),
    );
    this.writers.delete(threadId);
  }

  /**
   * 按 持久化层的 `thread-log` 模块 的一致性约束执行 `unarchive` 状态变更。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 持久化层的 `thread-log` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async unarchive(threadId: string): Promise<void> {
    await mkdir(activeThreadsDir(this.root), { recursive: true });
    await rename(
      archivedThreadLogPath(threadId, this.root),
      threadLogPath(threadId, this.root),
    );
  }

  /**
   * 按 持久化层的 `thread-log` 模块 的一致性约束执行 `delete` 状态变更。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `archived`: 显式控制 `delete` 分支的布尔值；只影响当前调用。
   *
   * Returns:
   * - Promise 在 持久化层的 `thread-log` 模块 的异步副作用完整提交后兑现，不返回业务值。
   *
   * Throws:
   * - 当 持久化层的 `thread-log` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async delete(threadId: string, archived: boolean): Promise<void> {
    await this.flush(threadId);
    await rm(
      archived
        ? archivedThreadLogPath(threadId, this.root)
        : threadLogPath(threadId, this.root),
      { force: false },
    );
    this.writers.delete(threadId);
  }

  /**
   * 执行 持久化层的 `thread-log` 模块 定义的 `exists` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `archived`: 显式控制 `exists` 分支的布尔值；只影响当前调用。
   *
   * Returns:
   * - Promise 在 持久化层的 `thread-log` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async exists(threadId: string, archived = false): Promise<boolean> {
    try {
      await stat(
        archived
          ? archivedThreadLogPath(threadId, this.root)
          : threadLogPath(threadId, this.root),
      );
      return true;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    }
  }

  /**
   * 读取 持久化层的 `thread-log` 模块 的 `listThreadIds` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `archived`: 显式控制 `listThreadIds` 分支的布尔值；只影响当前调用。
   *
   * Returns:
   * - Promise 在 持久化层的 `thread-log` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async listThreadIds(archived = false): Promise<readonly string[]> {
    const directory = archived
      ? archivedThreadsDir(this.root)
      : activeThreadsDir(this.root);
    await mkdir(directory, { recursive: true });
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name.slice(0, -'.jsonl'.length))
      .sort();
  }

  /**
   * 在 持久化层的 `thread-log` 模块 中执行 `flush` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 持久化层的 `thread-log` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async flush(threadId: string): Promise<void> {
    await this.writers.get(threadId)?.queue;
  }

  private async appendQueued(
    threadId: string,
    record: NewThreadRecord,
  ): Promise<ThreadRecord> {
    const writer = await this.writerFor(threadId);
    let resolveResult: (value: ThreadRecord) => void = () => undefined;
    let rejectResult: (reason: unknown) => void = () => undefined;
    const result = new Promise<ThreadRecord>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const operation = writer.queue.then(async () => {
      const fullRecord = parseThreadRecord(
        {
          ...record,
          schema: 1,
          seq: writer.nextSeq,
          threadId,
          createdAt: new Date().toISOString(),
        },
        `${threadId}:${writer.nextSeq}`,
      );
      const handle = await open(threadLogPath(threadId, this.root), 'a', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(fullRecord)}\n`, 'utf8');
        if (requiresFlush(fullRecord)) await handle.sync();
      } finally {
        await handle.close();
      }
      writer.nextSeq += 1;
      this.listeners.get(threadId)?.(fullRecord);
      resolveResult(fullRecord);
    });
    operation.catch(rejectResult);
    writer.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async writerFor(threadId: string): Promise<WriterState> {
    const existing = this.writers.get(threadId);
    if (existing !== undefined) return existing;
    const records = await this.read(threadId);
    const writer = {
      nextSeq: (records.at(-1)?.seq ?? 0) + 1,
      queue: Promise.resolve(),
    };
    this.writers.set(threadId, writer);
    return writer;
  }

  private async readPath(
    path: string,
    expectedThreadId: string,
  ): Promise<readonly ThreadRecord[]> {
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new AppServerError({
          type: 'threadNotFound',
          message: `Thread ${expectedThreadId} does not exist.`,
          cause: error,
        });
      }
      throw error;
    }
    if (content === '' || !content.endsWith('\n')) {
      throw corrupt(path, 'file is empty or its final line is incomplete');
    }
    const lines = content.slice(0, -1).split('\n');
    const records: ThreadRecord[] = [];
    for (const [lineIndex, line] of lines.entries()) {
      if (line.trim() === '')
        throw corrupt(path, `line ${lineIndex + 1} is empty`);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw corrupt(path, `line ${lineIndex + 1} is invalid JSON`, error);
      }
      let record: ThreadRecord;
      try {
        record = parseThreadRecord(value, `${path}:${lineIndex + 1}`);
      } catch (error) {
        throw corrupt(path, `line ${lineIndex + 1} has invalid schema`, error);
      }
      const expectedSeq = lineIndex + 1;
      if (record.seq !== expectedSeq) {
        throw corrupt(
          path,
          `line ${expectedSeq} has seq ${record.seq}, expected ${expectedSeq}`,
        );
      }
      if (record.threadId !== expectedThreadId) {
        throw corrupt(
          path,
          `line ${expectedSeq} belongs to thread ${record.threadId}`,
        );
      }
      if (expectedSeq === 1 && record.kind !== 'thread.created') {
        throw corrupt(path, 'first record is not thread.created');
      }
      records.push(record);
    }
    return records;
  }
}

function requiresFlush(record: ThreadRecord): boolean {
  return [
    'turn.completed',
    'turn.interrupted',
    'turn.failed',
    'item.completed',
    'serverRequest.created',
    'serverRequest.resolved',
  ].includes(record.kind);
}

function corrupt(
  path: string,
  reason: string,
  cause?: unknown,
): AppServerError {
  return new AppServerError({
    type: 'storageCorrupt',
    message: `Thread log ${path} is corrupt: ${reason}.`,
    details: { path, reason },
    cause,
  });
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && errnoCode(error) === code;
}
